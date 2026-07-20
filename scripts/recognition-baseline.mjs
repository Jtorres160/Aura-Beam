// ─── DEV-ONLY · Recognition Baseline (Scanner V2 · Milestone 0) ─────────────
// Companion to src/lib/scanner/recognition-baseline.ts. Reads stored scan
// telemetry and prints the M0 recognition baseline — outcome distribution,
// Recognition-Memory shadow audit (incl. the serve-safety verdict), repeat-scan
// / provider-independence gains, ground-truth volume, failure modes, OCR cost.
//
// This is OBSERVATION tooling, byte-for-byte the same read pattern as
// telemetry-report.mjs: it issues findMany/count and nothing else, is never
// imported by the app, and cannot change a scan result.
//
// Usage:
//   node scripts/recognition-baseline.mjs                    # all telemetry
//   node scripts/recognition-baseline.mjs --since day0       # from Telemetry Day 0
//   node scripts/recognition-baseline.mjs --game POKEMON
//   node scripts/recognition-baseline.mjs --json             # structured output
//
// Reads DATABASE_URL from the environment (.env). It measures whichever database
// that points at — it does not choose for you.

import { register } from "node:module";
import { createRequire } from "node:module";

register("../test/alias-loader.mjs", import.meta.url);
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const { analyzeRecognitionBaseline, formatRecognitionBaseline, analyzeArtPickAgreement, formatArtPickAgreement } = await import(
  "../src/lib/scanner/recognition-baseline.ts"
);
const { DEV_USER } = await import("../src/lib/auth-dev-bypass.ts");

/** Telemetry Day 0 — the Phase 5.13C truth-boundary deploy. */
const DAY_0 = "2026-07-15T20:25:59Z";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log("Usage: node scripts/recognition-baseline.mjs [--since <date|day0>] [--until <date>] [--game MTG|POKEMON|YUGIOH] [--json]");
  process.exit(0);
}

function parseDate(raw, label) {
  if (!raw) return undefined;
  const iso = raw === "day0" ? DAY_0 : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    console.error(`Bad --${label}: "${raw}". Use an ISO date, or "day0".`);
    process.exit(1);
  }
  return d;
}

const from = parseDate(flag("since"), "since");
const to = parseDate(flag("until"), "until");
const game = flag("game");

const prisma = new PrismaClient();

const createdAtWindow =
  from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};

// Development rows are NOT collector scans — excluded, exactly as
// telemetry-report.mjs does, so the baseline reflects real usage only.
const rows = await prisma.scanHistory.findMany({
  where: { ocrText: { not: null }, userId: { not: DEV_USER.id }, ...createdAtWindow },
  select: { ocrText: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});

const records = [];
let legacyRawOcr = 0;
for (const row of rows) {
  let parsed;
  try {
    parsed = JSON.parse(row.ocrText);
  } catch {
    legacyRawOcr++;
    continue;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) {
    legacyRawOcr++;
    continue;
  }
  if (game && parsed.game !== game) continue;
  records.push(parsed);
}

const baseline = analyzeRecognitionBaseline(records);
const artPick = analyzeArtPickAgreement(records);

if (has("json")) {
  console.log(JSON.stringify({ baseline, artPick, skipped: { legacyRawOcr } }, null, 2));
} else {
  console.log(formatRecognitionBaseline(baseline));
  console.log("");
  console.log(formatArtPickAgreement(artPick));
  console.log("");
  console.log("Source rows");
  console.log("───────────");
  console.log(`  ScanHistory rows read      ${rows.length}`);
  console.log(`  v1 telemetry records       ${records.length}`);
  console.log(`  legacy/unrecognized rows   ${legacyRawOcr}`);
  if (from) console.log(`\n  Filtered from ${from.toISOString()}${flag("since") === "day0" ? " (Telemetry Day 0)" : ""}`);
}

await prisma.$disconnect();
