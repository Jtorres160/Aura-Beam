// ─── Scanner V2 · M-CATALOG — Local Catalog Builder ─────────────────────────
// Populates catalog_cards: one row per Pokémon printing, keyed by the Pokémon TCG
// API card id, holding exactly the fields formatPokemonCard() produces — so a
// catalog row maps 1:1 to a CandidatePrinting and the M4 repoint can reconstruct
// an identical result without touching the live API.
//
// SIBLING to build-fingerprint-index.mjs, not an extension of it (disclosed in
// docs/scanner-v2/M-CATALOG-investigation.md §5). Why separate: the fingerprint
// builder executes at top level and unconditionally loads MobileCLIP — useless
// for a data-only import — and it is a proven artifact best left untouched. This
// script shares the parts that MATTER via real imports, not copy-paste:
//   • transport → fetchProviderJson (src/lib/providers/http.ts), same classified
//     timeout + the Phase 5.19 retry. Not re-implemented.
//   • normalization → formatPokemonCard (src/lib/services/pokemon.ts), the SAME
//     formatter the scan path uses. The catalog therefore cannot drift from what
//     candidate generation expects — it stores that function's own output.
//
// Only the thin enumeration (set list + per-set card list, with a WIDENED select
// so prices/rarity/set come back too) is local, mirroring the fingerprint
// builder's shape so the two read alike.
//
// Truth boundary (AGENTS.md): a card that can't be fetched/normalized is logged
// and skipped — never written half-formed, never fabricated. One bad card never
// aborts a set; one bad set never aborts the run.
//
// Writes go through the pooled DATABASE_URL via the typed Prisma client (plain
// columns — no raw SQL, unlike the vector table). Upsert on the unique externalId
// makes re-runs idempotent.
//
// Usage:
//   node scripts/build-catalog.mjs --set mcd19            # one set (scoped run)
//   node scripts/build-catalog.mjs --set base1 --set sv3  # (repeat --set) — see note
//   node scripts/build-catalog.mjs --sets-from ids.txt    # sets listed in a file
//   node scripts/build-catalog.mjs                        # FULL catalog (resume on)
//   node scripts/build-catalog.mjs --no-resume            # full catalog, rewrite all
//   node scripts/build-catalog.mjs --delay 500            # ms between calls (default 300)
//   node scripts/build-catalog.mjs --help

import { register } from "node:module";
import { readFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);

// ─── .env → process.env (minimal; no dotenv dep) — same as the fp builder ────
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { PrismaClient } = await import("@prisma/client");
// The enumerate → list → normalize → upsert core lives in the shared M5 module so
// this CLI and /api/cron/refresh-catalog run the exact same code path (no
// duplication). This script is now just the driver: flag parsing, resume policy,
// per-set orchestration, and the run report.
const { fetchAllSets, syncSet, classifyFailure } = await import(
  "../src/lib/services/catalog-sync.ts"
);

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
// Collect every occurrence of a repeated flag, e.g. --set a --set b.
const flags = (name) =>
  argv.reduce((acc, cur, i) => (cur === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log("Usage: node scripts/build-catalog.mjs [--set <id> ...] [--sets-from <file>] [--resume|--no-resume] [--delay <ms>] [--list-retries <n>] [--list-backoff <ms>]");
  console.log("  No --set → FULL catalog (all sets), resume ON by default.");
  console.log("  --set <id> (repeatable) → those sets only (scoped run), resume OFF by default.");
  process.exit(0);
}

const SINGLE_SETS = flags("set");            // one or more → scoped mode
const SCOPED = SINGLE_SETS.length > 0;
const SETS_FROM = flag("sets-from");
const DELAY_MS = Number(flag("delay") ?? 300);
// Resume OFF for a manual scoped run (predictable re-run), ON for full catalog.
const RESUME = SCOPED ? has("resume") : !has("no-resume");

// The per-set list call is the flaky point (see fp builder); be patient with it.
const LIST_RETRIES = Number(flag("list-retries") ?? 6);
const LIST_BACKOFF_MS = Number(flag("list-backoff") ?? 2000);
const listRetry = { tries: LIST_RETRIES, baseMs: LIST_BACKOFF_MS };

const nfmt = (n) => n.toLocaleString("en-US");

// ─── Enumeration (delegates to the shared core; only the --sets-from file branch
//     is CLI-local) ────────────────────────────────────────────────────────────
async function fetchAllSetIds() {
  if (SETS_FROM) {
    return readFileSync(SETS_FROM, "utf8")
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  }
  const sets = await fetchAllSets(listRetry);
  return sets.map((s) => s.id);
}

// ─── Driver ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const mode = SCOPED ? `scoped [${SINGLE_SETS.join(", ")}]` : "FULL catalog";
console.log(`Catalog build — ${mode}, resume=${RESUME ? "on" : "off"}`);
console.log("═".repeat(64));

const prisma = new PrismaClient();

let setIds;
try {
  setIds = SCOPED ? SINGLE_SETS : await fetchAllSetIds();
} catch (err) {
  console.error(`Fatal: could not enumerate sets: ${err?.message ?? err}`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`Sets to process: ${setIds.length}`);

const running = { upserted: 0, skipped: 0, failed: 0, listed: 0, failures: [] };
const failedSets = [];

for (const [idx, setId] of setIds.entries()) {
  const n = `${idx + 1}/${setIds.length}`;
  try {
    const s = await syncSet(prisma, setId, { resume: RESUME, delayMs: DELAY_MS, retry: listRetry });
    running.listed += s.listed;
    running.upserted += s.upserted;
    running.skipped += s.skipped;
    running.failed += s.failed;
    running.failures.push(...s.failures);
    console.log(
      `Set ${n} (${setId}) done — listed ${s.listed}, +${s.upserted} upserted, ${s.skipped} skipped, ${s.failed} failed` +
      ` — ${nfmt(running.upserted)} upserted so far`,
    );
  } catch (err) {
    const why = err?.message ?? String(err);
    failedSets.push({ setId, reason: classifyFailure(why), detail: why });
    console.log(`Set ${n} (${setId}) FAILED to list cards — ${why}. Logged as failed set; continuing.`);
  }
  if (idx < setIds.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
}

await prisma.$disconnect();

// ─── Final report ────────────────────────────────────────────────────────────
const secs = Math.round((Date.now() - t0) / 1000);
const mm = Math.floor(secs / 60), ss = secs % 60;
const reasonBreakdown = {};
for (const f of running.failures) reasonBreakdown[f.reason] = (reasonBreakdown[f.reason] ?? 0) + 1;

console.log("\n" + "═".repeat(64));
console.log("FINAL SUMMARY");
console.log(`  Mode                 ${mode}`);
console.log(`  Sets attempted       ${setIds.length}`);
console.log(`  Sets fully failed    ${failedSets.length}`);
console.log(`  Cards listed         ${nfmt(running.listed)}`);
console.log(`  Rows upserted        ${nfmt(running.upserted)}`);
console.log(`  Skipped (had)        ${nfmt(running.skipped)}`);
console.log(`  Card failures        ${nfmt(running.failed)}`);
console.log(`  Wall-clock           ${mm}m ${ss}s`);
if (Object.keys(reasonBreakdown).length) {
  console.log("\n  Card-failure breakdown (reason → count):");
  for (const [r, n] of Object.entries(reasonBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${r}`);
  }
}
if (failedSets.length) {
  console.log("\n  Failed sets (set → reason):");
  for (const f of failedSets) console.log(`    ${f.setId} → ${f.reason} (${f.detail})`);
}
