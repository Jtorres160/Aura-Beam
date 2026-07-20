// ─── Scanner V2 · M2-A — Fingerprint Matcher Proof ──────────────────────────
// Self-consistency check for src/lib/scanner/fingerprint-match.ts, run BEFORE
// the matcher goes anywhere near a live scan. No real user photo exists anywhere
// today, so we prove the query path a different way: take cards already in the
// index, re-fetch each one's OWN reference image (the exact imageUrl the index
// was built from), run it back through matchFingerprint(), and assert the #1
// result is that same card at a near-zero distance.
//
// If the query embedding used a different model/preprocessing than the index,
// this distance would be large and the top hit wrong — so a pass proves the
// model singleton, the preprocessing, the distance metric, and the HNSW query
// all agree end-to-end.
//
// Read-only apart from nothing — it writes nothing. Reads DATABASE_URL from .env.
//
// Usage:
//   node scripts/verify-fingerprint-match.mjs            # ~15 random cards
//   node scripts/verify-fingerprint-match.mjs --n 20     # sample size
//   node scripts/verify-fingerprint-match.mjs --max-dist 0.02

import { register } from "node:module";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);
const require = createRequire(import.meta.url);

// Load .env so POKEMON_TCG_API_KEY / DATABASE_URL are present (same as the
// builder script). Don't clobber the real environment.
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { PrismaClient } = require("@prisma/client");
const { matchFingerprint } = await import("../src/lib/scanner/fingerprint-match.ts");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const N = Number(flag("n") ?? 15);
const MAX_DIST = Number(flag("max-dist") ?? 0.02); // identical image re-embedded → ~0

async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const prisma = new PrismaClient();

// A spread across sets: pick the first N distinct-set cards from a random order.
const rows = await prisma.$queryRawUnsafe(`
  SELECT DISTINCT ON ("setCode") "externalId", "setCode", "imageUrl"
  FROM card_fingerprints
  WHERE "imageUrl" IS NOT NULL
  ORDER BY "setCode", random()
  LIMIT ${Math.max(1, N)}
`);

console.log(`Fingerprint matcher self-consistency proof — ${rows.length} cards across ${new Set(rows.map((r) => r.setCode)).size} sets`);
console.log(`Pass = #1 match is the card itself AND distance ≤ ${MAX_DIST}`);
console.log("─".repeat(72));

// First, prove the silent-degrade contract: a non-POKEMON game returns null.
const nonPokemon = await matchFingerprint(Buffer.from([0]), "MTG");
const degradeOk = nonPokemon === null;
console.log(`Silent-degrade (game=MTG → null): ${degradeOk ? "PASS" : "FAIL (got " + JSON.stringify(nonPokemon) + ")"}`);
console.log("─".repeat(72));

let pass = 0;
let fail = 0;
const failures = [];

for (const [i, row] of rows.entries()) {
  const tag = `[${i + 1}/${rows.length}] ${row.externalId} (${row.setCode})`;
  try {
    const buf = await downloadImage(row.imageUrl);
    const matches = await matchFingerprint(buf, "POKEMON");
    if (!matches || matches.length === 0) {
      fail++;
      failures.push({ externalId: row.externalId, why: matches === null ? "matcher returned null" : "no matches" });
      console.log(`  ✗ ${tag} — ${matches === null ? "null" : "empty"}`);
      continue;
    }
    const top = matches[0];
    const selfRank = matches.findIndex((m) => m.externalId === row.externalId);
    const ok = top.externalId === row.externalId && top.distance <= MAX_DIST;
    if (ok) {
      pass++;
      console.log(`  ✓ ${tag} — dist=${top.distance.toExponential(2)}`);
    } else {
      fail++;
      failures.push({
        externalId: row.externalId,
        why: `#1 was ${top.externalId} (dist=${top.distance.toFixed(4)}); self rank=${selfRank}`,
      });
      console.log(`  ✗ ${tag} — #1=${top.externalId} dist=${top.distance.toFixed(4)}, self rank=${selfRank}`);
    }
  } catch (err) {
    fail++;
    failures.push({ externalId: row.externalId, why: err?.message ?? String(err) });
    console.log(`  ✗ ${tag} — ${err?.message ?? err}`);
  }
}

await prisma.$disconnect();

console.log("─".repeat(72));
console.log(`Summary: ${pass} pass / ${fail} fail (of ${rows.length}) + silent-degrade ${degradeOk ? "pass" : "FAIL"}`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  ${f.externalId} → ${f.why}`);
}
const allGood = fail === 0 && degradeOk;
console.log(allGood ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(allGood ? 0 : 1);
