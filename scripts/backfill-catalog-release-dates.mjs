// ─── Scanner V2 · M-CATALOG · M7 — release-date backfill ─────────────────────
// Populates catalog_cards.setReleaseDate for rows imported before M7 added the
// column, so candidate generation can order printings newest-first.
//
// Set-level, not card-level: release date is a property of the SET, and
// externalId is `${set.id}-${number}`, so one updateMany per set covers every
// card in it. That is ~170 API-free UPDATEs off a single /v2/sets call, instead
// of re-fetching 20k cards. fetchAllSets() is the same enumeration the importer
// and the M5 cron use — no reimplementation, no second source of truth.
//
// Idempotent: re-running rewrites the same values. Safe to re-run after a
// partial run. Read-modify of ONE additive column; touches nothing else.
//
// Usage:
//   node scripts/backfill-catalog-release-dates.mjs --dry-run
//   node scripts/backfill-catalog-release-dates.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const dryRun = process.argv.includes("--dry-run");
const { PrismaClient } = await import("@prisma/client");
const { fetchAllSets, parseSetReleaseDate } = await import("../src/lib/services/catalog-sync.ts");

const prisma = new PrismaClient();
const before = await prisma.catalogCard.count({ where: { setReleaseDate: null } });
console.log(`catalog_cards with NULL setReleaseDate before: ${before}`);

// Throws on a non-answer rather than treating a flaky call as "no sets" — the
// same truth boundary the importer holds (a failed provider is not an empty one).
const sets = await fetchAllSets();
console.log(`sets enumerated: ${sets.length}${dryRun ? "  [DRY RUN — no writes]" : ""}\n`);

let updated = 0, skippedNoDate = 0, setsTouched = 0;
for (const s of sets) {
  const date = parseSetReleaseDate(s.releaseDate);
  if (!date) {
    skippedNoDate++;
    console.log(`  ${s.id.padEnd(12)} — no usable releaseDate ("${s.releaseDate}"), left NULL`);
    continue;
  }
  if (dryRun) {
    const n = await prisma.catalogCard.count({ where: { externalId: { startsWith: `${s.id}-` } } });
    if (n) { setsTouched++; updated += n; console.log(`  ${s.id.padEnd(12)} ${date.toISOString().slice(0, 10)} → ${n} rows`); }
    continue;
  }
  const res = await prisma.catalogCard.updateMany({
    where: { externalId: { startsWith: `${s.id}-` } },
    data: { setReleaseDate: date },
  });
  if (res.count) { setsTouched++; updated += res.count; console.log(`  ${s.id.padEnd(12)} ${date.toISOString().slice(0, 10)} → ${res.count} rows`); }
}

const after = dryRun ? before : await prisma.catalogCard.count({ where: { setReleaseDate: null } });
console.log(`\n${"═".repeat(56)}`);
console.log(`  sets with rows in catalog   ${setsTouched}`);
console.log(`  rows ${dryRun ? "that would be " : ""}updated          ${updated}`);
console.log(`  sets lacking a releaseDate  ${skippedNoDate}`);
console.log(`  rows still NULL after       ${after}`);
console.log("═".repeat(56));

await prisma.$disconnect();
process.exit(0);
