// ─── DEV-ONLY · Set-code-optional matching rollout report ────────────────────
// The measurement that governs SETCODE_OPTIONAL_MATCH_ENABLED. Run it after the
// flag has been live for a while to answer, from real data:
//
//   (a) FIRE RATE — how often the new tier resolves a scan outright vs. the scan
//       falling through to the old disambiguation grid. Answerable TODAY from
//       existing telemetry: decision.method carries "name-cn-total-verified"
//       for free (acceptDecision stamps it; buildScanTelemetry persists it).
//
//   (b) OVERTURN RATE — of the scans it resolved, how many the collector
//       rejected. This is the number that should govern whether 0.9 moves.
//       NOT ANSWERABLE TODAY. See the honesty note below.
//
// This is OBSERVATION tooling, same contract as telemetry-report.mjs: it issues
// findMany and nothing else, is never imported by the app, and running it cannot
// change a scan result.
//
// ─── WHY (b) READS "unmeasurable" AND NOT "0%" ──────────────────────────────
// An auto-accepted scan reaches the review screen, which offers exactly two
// actions: "Add to Collection" (POST /api/collections/add with a cardId and NO
// scanId) and "Scan Next" (a pure client-side reset). Neither writes anything
// back to the scan's telemetry row. So today:
//
//   • a collector who KEEPS a wrongly-matched card leaves no record, and
//   • a collector who REJECTS one leaves no record either.
//
// The two are indistinguishable from each other AND from a user who simply
// walked away. Reporting that as "0% overturned" would be inventing a
// measurement out of missing instrumentation — precisely the failure the truth
// boundary exists to prevent. It prints UNMEASURABLE until the confirmation /
// rejection fields land (see docs/scanner-v2/setcode-optional-matching.md §
// Rollout). The reader is forward-compatible: the moment those fields exist,
// this script reports the rate with no edit.
//
// Usage:
//   node scripts/setcode-optional-rollout.mjs
//   node scripts/setcode-optional-rollout.mjs --since 2026-08-01
//   node scripts/setcode-optional-rollout.mjs --json
//
// Reads DATABASE_URL from the environment (.env). It measures whichever
// database that points at — it does not choose for you.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

if (has("help")) {
  console.log("Usage: node scripts/setcode-optional-rollout.mjs [--since YYYY-MM-DD] [--json]");
  process.exit(0);
}

const since = flag("since") ? new Date(flag("since")) : undefined;
const METHOD = "name-cn-total-verified";

// ─── Sample-size gates (see the doc for the reasoning) ──────────────────────
const N_SAFETY_FLOOR = 60;   // rule of three: 0 overturns in 60 ⇒ true rate <5% (95%)
const N_RAISE_GATE = 200;    // estimates a ~5% rate to roughly ±3pp at 95%
const N_KILL_FLOOR = 30;     // enough to act on a clearly-bad rate without waiting

const isObj = (x) => typeof x === "object" && x !== null;
const s = (x) => (typeof x === "string" && x.trim() !== "" ? x.trim() : undefined);
const pct = (a, b) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`);

const prisma = new PrismaClient();
const rows = await prisma.scanHistory.findMany({
  where: { ocrText: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) },
  select: { id: true, ocrText: true, createdAt: true, matchMethod: true },
  orderBy: { createdAt: "asc" },
});

const stat = {
  scanned: rows.length,
  parsed: 0,
  pokemon: 0,
  byMethod: {},
  tierFired: 0,
  tierConfirmed: 0,
  tierOverturned: 0,
  tierNoSignal: 0,
  overturnDetail: [],
  gridFallthrough: 0,
};

for (const row of rows) {
  let p;
  try { p = JSON.parse(row.ocrText); } catch { continue; }
  if (!isObj(p) || p.v !== 1) continue;
  // Failure-stage records have no decision — they never reached the scorer.
  if (!isObj(p.decision)) continue;
  stat.parsed++;
  const game = s(p.game) ?? s(p.selection?.game);
  if ((game ?? "").toUpperCase() !== "POKEMON") continue;
  stat.pokemon++;

  const method = s(p.decision.method) ?? "(none)";
  const key = p.decision.action === "accept" ? method : `${p.decision.action}:${method}`;
  stat.byMethod[key] = (stat.byMethod[key] ?? 0) + 1;

  if (p.decision.action !== "accept" || method !== METHOD) {
    if (p.decision.action === "disambiguate") stat.gridFallthrough++;
    continue;
  }
  stat.tierFired++;

  // ─── (b) The overturn signal, when it exists ──────────────────────────────
  // Forward-compatible reader. `confirmation` = the collector added the printing
  // this tier chose. `rejection` = they declined it. `selection` pointing at a
  // DIFFERENT externalId is an overturn too (they picked another card for this
  // scan). Absent all three, we know nothing — and say so.
  const chosen = s(p.decision.bestMatchExternalId) ?? s(p.acceptedExternalId);
  const confirmation = isObj(p.confirmation) ? s(p.confirmation.externalId) : undefined;
  const rejection = isObj(p.rejection) ? p.rejection : undefined;
  const selection = isObj(p.selection) ? s(p.selection.externalId) : undefined;

  if (rejection) {
    stat.tierOverturned++;
    stat.overturnDetail.push({ scanId: row.id, chose: chosen, then: "rejected" });
  } else if (selection && chosen && selection !== chosen) {
    stat.tierOverturned++;
    stat.overturnDetail.push({ scanId: row.id, chose: chosen, then: selection });
  } else if (confirmation || selection) {
    stat.tierConfirmed++;
  } else {
    stat.tierNoSignal++;
  }
}

await prisma.$disconnect();

const judged = stat.tierConfirmed + stat.tierOverturned;

if (has("json")) {
  console.log(JSON.stringify({ ...stat, judged, gates: { N_KILL_FLOOR, N_SAFETY_FLOOR, N_RAISE_GATE } }, null, 2));
  process.exit(0);
}

console.log(`\n── Set-code-optional matching · rollout report${since ? ` (since ${since.toISOString().slice(0, 10)})` : ""}`);
console.log(`scan rows read: ${stat.scanned}; telemetry parsed: ${stat.parsed}; Pokémon w/ a decision: ${stat.pokemon}`);

console.log(`\n(a) FIRE RATE`);
console.log(`   resolved by ${METHOD}: ${stat.tierFired} (${pct(stat.tierFired, stat.pokemon)} of Pokémon scans)`);
console.log(`   still went to a disambiguation grid: ${stat.gridFallthrough} (${pct(stat.gridFallthrough, stat.pokemon)})`);
console.log(`   full decision breakdown:`);
for (const [k, v] of Object.entries(stat.byMethod).sort((a, b) => b[1] - a[1])) {
  console.log(`      ${String(v).padStart(5)}  ${k}`);
}

console.log(`\n(b) OVERTURN RATE`);
if (stat.tierFired === 0) {
  console.log(`   n/a — the tier has not fired yet. Is SETCODE_OPTIONAL_MATCH_ENABLED set in Vercel Production?`);
} else if (judged === 0) {
  console.log(`   UNMEASURABLE. ${stat.tierFired} scans resolved by this tier, ${stat.tierNoSignal} of them`);
  console.log(`   carry no confirmation/rejection signal at all.`);
  console.log(`   This is NOT "0% overturned" — the review screen writes nothing back to`);
  console.log(`   telemetry, so a kept card and a rejected card are indistinguishable.`);
  console.log(`   The confirmation/rejection instrumentation must ship before this number exists.`);
} else {
  const rate = stat.tierOverturned / judged;
  // Rule-of-three upper bound when zero overturns observed; Wald otherwise.
  const upper = stat.tierOverturned === 0
    ? 3 / judged
    : rate + 1.96 * Math.sqrt((rate * (1 - rate)) / judged);
  console.log(`   judged (confirmed or overturned): ${judged} of ${stat.tierFired} fired`);
  console.log(`   overturned: ${stat.tierOverturned} → ${pct(stat.tierOverturned, judged)}  (95% upper bound ≈ ${(upper * 100).toFixed(1)}%)`);
  console.log(`   unjudged (no signal): ${stat.tierNoSignal}`);
  for (const d of stat.overturnDetail) console.log(`      ${d.scanId}: chose ${d.chose} → ${d.then}`);

  console.log(`\n   VERDICT against the pre-registered gates:`);
  if (judged < N_KILL_FLOOR) {
    console.log(`      HOLD — ${judged} judged is below the ${N_KILL_FLOOR} floor for ANY conclusion.`);
  } else if (rate >= 0.10) {
    console.log(`      PULL THE FLAG — overturn ${pct(stat.tierOverturned, judged)} ≥ 10% at n=${judged}.`);
  } else if (judged < N_RAISE_GATE) {
    console.log(`      KEEP AT 0.9 — rate looks acceptable but n=${judged} < ${N_RAISE_GATE}; not enough to raise.`);
  } else if (upper <= 0.05) {
    console.log(`      ELIGIBLE TO RAISE toward ACCEPT_THRESHOLD_AUTOSCAN (n=${judged}, upper bound ${(upper * 100).toFixed(1)}% ≤ 5%).`);
  } else {
    console.log(`      KEEP AT 0.9 — n is sufficient but the upper bound ${(upper * 100).toFixed(1)}% exceeds 5%.`);
  }
}
console.log(`\ngates: kill floor n≥${N_KILL_FLOOR} · safety floor n≥${N_SAFETY_FLOOR} · raise gate n≥${N_RAISE_GATE}\n`);
