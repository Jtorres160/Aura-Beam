// ─── DEV-ONLY · Auto-accept accuracy report ──────────────────────────────────
// The measurement that governs SETCODE_OPTIONAL_MATCH_ENABLED — and, because
// the same instrumentation covers every method, the benchmark that flag has to
// beat.
//
// It answers, per accept method, from real data:
//
//   (a) FIRE RATE — how often the method resolves a scan outright vs. the scan
//       falling through to a disambiguation grid. Answerable with no new fields:
//       decision.method is stamped by acceptDecision and persisted by
//       buildScanTelemetry.
//
//   (b) OVERTURN RATE — of the scans it resolved, how many the collector
//       rejected, from the confirmation/rejection labels. Reported PER METHOD on
//       purpose: name-cn-total-verified ships at 0.9 and set-cn-verified is
//       already live at 0.97, so the honest question is never "is 0.9 good?" in
//       the abstract but "is it worse than what we already trust?" Treating the
//       incumbent's accuracy as an assumed zero would rig that comparison.
//
//   (c) FABRICATED-TOTAL ALARMS — overturns where the printed total OCR read
//       does not match the card the collector actually named, i.e. the total did
//       not come off the physical card at all. Per the pre-registered rule this
//       is an immediate recommendation to pull the flag REGARDLESS of n, so it
//       is surfaced separately and never averaged into the rate.
//
// This is OBSERVATION tooling, same contract as telemetry-report.mjs: it issues
// findMany and nothing else, is never imported by the app, and running it cannot
// change a scan result.
//
// ─── ON REPORTING RATES FROM SMALL SAMPLES ──────────────────────────────────
// A method below the kill floor gets its RAW COUNTS printed and no percentage.
// Counts are facts; "33.3% overturned" from n=3 is a number that reads as a
// finding and isn't one. Each method carries an explicit sample grade saying
// which gate — if any — its n currently clears.
//
// Usage:
//   node scripts/setcode-optional-rollout.mjs
//   node scripts/setcode-optional-rollout.mjs --since 2026-08-01
//   node scripts/setcode-optional-rollout.mjs --json
//
// Reads DATABASE_URL from the environment (.env). It measures whichever
// database that points at — it does not choose for you.

import { createRequire, register } from "node:module";

// The confidence table is imported rather than copied so the report can never
// disagree with the thresholds the scanner actually uses.
register("../test/alias-loader.mjs", import.meta.url);
const { METHOD_CONFIDENCE } = await import("../src/lib/scanner/decision.ts");

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
/** The flagged tier. Only THIS method is governed by the pre-registered
 *  raise/pull rules; every other method is reported as benchmark context. */
const FLAGGED_METHOD = "name-cn-total-verified";

// ─── Sample-size gates (reasoning in docs/scanner-v2/setcode-optional-matching.md)
const N_KILL_FLOOR = 30;     // enough to act on a clearly-bad rate without waiting
const N_SAFETY_FLOOR = 60;   // rule of three: 0 overturns in 60 ⇒ true rate <5% (95%)
const N_RAISE_GATE = 200;    // estimates a ~5% rate to roughly ±3pp at 95%

const isObj = (x) => typeof x === "object" && x !== null;
const s = (x) => (typeof x === "string" && x.trim() !== "" ? x.trim() : undefined);
const pct = (a, b) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`);
const totalOf = (cn) => {
  const d = String(cn).split("/")[1];
  if (d === undefined) return null;
  const t = d.trim();
  return /^\d+$/.test(t) ? Number.parseInt(t, 10) : null;
};

/** Which gate does this judged-sample size clear? */
function gradeSample(n) {
  if (n === 0) return { grade: "no data yet", rateOk: false };
  if (n < N_KILL_FLOOR) return { grade: `accumulating (${n}/${N_KILL_FLOOR})`, rateOk: false };
  if (n < N_SAFETY_FLOOR) return { grade: `n≥${N_KILL_FLOOR} · kill-floor only`, rateOk: true };
  if (n < N_RAISE_GATE) return { grade: `n≥${N_SAFETY_FLOOR} · rule-of-three floor`, rateOk: true };
  return { grade: `n≥${N_RAISE_GATE} · ±3pp estimate`, rateOk: true };
}

const prisma = new PrismaClient();
const rows = await prisma.scanHistory.findMany({
  where: { ocrText: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) },
  select: { id: true, ocrText: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});

const methods = {};                 // per accept-method stats
const nonAccept = {};               // disambiguate / not-found breakdown
const alarms = [];                  // fabricated-total overturns
let parsed = 0, pokemon = 0;

const methodStat = (m) => (methods[m] ??= {
  method: m, confidence: METHOD_CONFIDENCE[m] ?? null,
  fired: 0, confirmed: 0, overturned: 0, unjudged: 0, detail: [],
});

for (const row of rows) {
  let p;
  try { p = JSON.parse(row.ocrText); } catch { continue; }
  if (!isObj(p) || p.v !== 1) continue;
  if (!isObj(p.decision)) continue;   // failure-stage rows never reached the scorer
  parsed++;
  const game = s(p.game) ?? s(p.selection?.game);
  if ((game ?? "").toUpperCase() !== "POKEMON") continue;
  pokemon++;

  const method = s(p.decision.method) ?? "(none)";
  if (p.decision.action !== "accept") {
    nonAccept[`${p.decision.action}:${method}`] = (nonAccept[`${p.decision.action}:${method}`] ?? 0) + 1;
    continue;
  }

  const st = methodStat(method);
  st.fired++;

  // What this accept chose, and what the collector said about it.
  const chosen = s(p.acceptedExternalId) ?? s(p.decision.bestMatchExternalId);
  const confirmation = isObj(p.confirmation) ? s(p.confirmation.externalId) : undefined;
  const rejection = isObj(p.rejection) ? p.rejection : undefined;
  const selection = isObj(p.selection) ? s(p.selection.externalId) : undefined;

  // An overturn is ANY signal naming a card other than the one that was
  // accepted — including a confirmation, because /api/collections/add records
  // what was ACTUALLY added, which is not always what was proposed.
  const namedInstead = [confirmation, selection, rejection?.replacedByExternalId]
    .find((id) => id && chosen && id !== chosen);

  if (rejection || namedInstead) {
    st.overturned++;
    st.detail.push({ scanId: row.id, chose: chosen, instead: namedInstead ?? "(rejected, no replacement named)" });

    // ─── (c) Did the printed total come off the physical card at all? ───────
    // The tier fired, so OCR's name+CN+total matched SOME real row. If the card
    // the collector actually named has a DIFFERENT printed total, then that
    // total was not read from the card in hand — it was fabricated or recalled,
    // and it happened to land on a real printing. That is the failure class the
    // fall-through safety property does NOT cover.
    if (method === FLAGGED_METHOD && namedInstead) {
      const readCn = isObj(p.evidence?.printing?.collectorNumber) ? s(p.evidence.printing.collectorNumber.value) : undefined;
      const readTotal = readCn ? totalOf(readCn) : null;
      const actual = await prisma.catalogCard.findUnique({
        where: { externalId: namedInstead },
        select: { externalId: true, name: true, setName: true, collectorNumber: true, setPrintedSize: true },
      }).catch(() => null);
      if (readTotal !== null && actual?.setPrintedSize != null && readTotal !== actual.setPrintedSize) {
        alarms.push({
          scanId: row.id, at: row.createdAt.toISOString().slice(0, 10),
          readCn, readTotal, chose: chosen,
          actual: `${actual.externalId} (${actual.name} ${actual.collectorNumber}/${actual.setPrintedSize} ${actual.setName})`,
        });
      }
    }
  } else if (confirmation || selection) {
    st.confirmed++;
  } else {
    st.unjudged++;
  }
}
await prisma.$disconnect();

const list = Object.values(methods).sort((a, b) => b.fired - a.fired);
for (const m of list) {
  m.judged = m.confirmed + m.overturned;
  const g = gradeSample(m.judged);
  m.grade = g.grade;
  m.rate = g.rateOk ? m.overturned / m.judged : null;
  m.upper = !g.rateOk ? null
    : m.overturned === 0 ? 3 / m.judged
    : m.rate + 1.96 * Math.sqrt((m.rate * (1 - m.rate)) / m.judged);
}

if (has("json")) {
  console.log(JSON.stringify({ parsed, pokemon, methods: list, nonAccept, alarms, gates: { N_KILL_FLOOR, N_SAFETY_FLOOR, N_RAISE_GATE } }, null, 2));
  process.exit(0);
}

console.log(`\n── Auto-accept accuracy${since ? ` (since ${since.toISOString().slice(0, 10)})` : ""}`);
console.log(`telemetry parsed: ${parsed}; Pokémon scans with a decision: ${pokemon}`);

const firedTotal = list.reduce((a, m) => a + m.fired, 0);
console.log(`\n(a) FIRE RATE — ${firedTotal} of ${pokemon} Pokémon scans auto-accepted (${pct(firedTotal, pokemon)})`);
for (const m of list) {
  console.log(`   ${String(m.fired).padStart(5)}  ${pct(m.fired, pokemon).padStart(6)}  ${m.method}${m.confidence != null ? ` @${m.confidence}` : ""}`);
}
const nonTotal = Object.values(nonAccept).reduce((a, b) => a + b, 0);
console.log(`   ${String(nonTotal).padStart(5)}  ${pct(nonTotal, pokemon).padStart(6)}  (did not auto-accept)`);
for (const [k, v] of Object.entries(nonAccept).sort((a, b) => b[1] - a[1])) {
  console.log(`         ${String(v).padStart(5)}  ${k}`);
}

console.log(`\n(b) OVERTURN RATE BY METHOD`);
console.log(`   ${"method".padEnd(24)} ${"conf".padEnd(5)} ${"fired".padStart(5)} ${"judged".padStart(6)} ${"overt".padStart(5)}  ${"rate".padEnd(20)} sample grade`);
for (const m of list) {
  const rateCell = m.rate === null
    ? "—"
    : `${pct(m.overturned, m.judged)} (≤${(m.upper * 100).toFixed(1)}% @95%)`;
  console.log(
    `   ${m.method.padEnd(24)} ${String(m.confidence ?? "—").padEnd(5)} ${String(m.fired).padStart(5)} ${String(m.judged).padStart(6)} ${String(m.overturned).padStart(5)}  ${rateCell.padEnd(20)} ${m.grade}`,
  );
}
const anyJudged = list.some((m) => m.judged > 0);
if (!anyJudged) {
  console.log(`\n   No method has a single judged decision yet.`);
  console.log(`   This is NOT "0% overturned" — it means the confirmation/rejection labels`);
  console.log(`   (PR #6) have not landed on any scan in this window. A rate will appear`);
  console.log(`   here once collectors start adding or declining auto-accepted matches.`);
}
for (const m of list) {
  if (!m.detail.length) continue;
  console.log(`\n   overturns · ${m.method}:`);
  for (const d of m.detail) console.log(`      ${d.scanId}: chose ${d.chose} → collector named ${d.instead}`);
}

console.log(`\n(c) FABRICATED-TOTAL ALARMS — ${alarms.length}`);
if (alarms.length === 0) {
  console.log(`   None. No overturn traces to a printed total that wasn't on the card.`);
} else {
  console.log(`   ⚠ PRE-REGISTERED PULL CONDITION MET — recommend disabling`);
  console.log(`     SETCODE_OPTIONAL_MATCH_ENABLED regardless of sample size.`);
  console.log(`     The fall-through safety property assumes a bad read finds no catalog row.`);
  console.log(`     These reads found one anyway, which means that assumption is false.`);
  for (const a of alarms) {
    console.log(`     ${a.at} ${a.scanId}: OCR read "${a.readCn}" (total ${a.readTotal}) → accepted ${a.chose}`);
    console.log(`        but the card was ${a.actual}`);
  }
}

// ─── Verdict, for the flagged tier only ─────────────────────────────────────
const tier = methods[FLAGGED_METHOD];
console.log(`\n── VERDICT · ${FLAGGED_METHOD} (the only method the pre-registered rules govern)`);
if (alarms.length > 0) {
  console.log(`   PULL THE FLAG — ${alarms.length} fabricated-total overturn(s). Sample size does not apply.`);
} else if (!tier || tier.fired === 0) {
  console.log(`   NOT ENABLED — no firings in this window. Is SETCODE_OPTIONAL_MATCH_ENABLED set in Vercel Production?`);
} else if (tier.judged < N_KILL_FLOOR) {
  console.log(`   HOLD — ${tier.fired} fired, ${tier.judged} judged; below the ${N_KILL_FLOOR} floor for ANY conclusion.`);
} else if (tier.rate >= 0.10) {
  console.log(`   PULL THE FLAG — overturn ${pct(tier.overturned, tier.judged)} ≥ 10% at n=${tier.judged}.`);
} else if (tier.judged < N_RAISE_GATE) {
  console.log(`   KEEP AT 0.9 — rate acceptable but n=${tier.judged} < ${N_RAISE_GATE}; not enough to raise.`);
} else if (tier.rate <= 0.02 && tier.upper <= 0.05) {
  console.log(`   ELIGIBLE TO RAISE toward ACCEPT_THRESHOLD_AUTOSCAN (n=${tier.judged}, rate ${pct(tier.overturned, tier.judged)}, upper ${(tier.upper * 100).toFixed(1)}%).`);
} else {
  console.log(`   KEEP AT 0.9 — n sufficient but rate/upper bound above the raise threshold.`);
}
const bench = methods["set-cn-verified"];
if (bench?.judged >= N_KILL_FLOOR && tier?.judged >= N_KILL_FLOOR) {
  console.log(`   benchmark · set-cn-verified @0.97 overturns ${pct(bench.overturned, bench.judged)} (n=${bench.judged})`);
} else if (bench) {
  console.log(`   benchmark · set-cn-verified @0.97: ${bench.judged} judged — not yet comparable.`);
}
console.log(`\ngates: kill floor n≥${N_KILL_FLOOR} · safety floor n≥${N_SAFETY_FLOOR} · raise gate n≥${N_RAISE_GATE}\n`);
