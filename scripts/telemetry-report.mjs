// ─── DEV-ONLY · Production Telemetry Report (Phase 5.14) ─────────────────────
// Companion to src/lib/scanner/telemetry-analysis.ts + telemetry-report.ts.
// Reads stored scan telemetry and prints the Phase 5.14 report.
//
// This is OBSERVATION tooling. It opens a READ-ONLY window onto ScanHistory:
// it issues findMany/count and nothing else, and it is never imported by the
// app. Running it cannot change a scan result.
//
// Usage:
//   node scripts/telemetry-report.mjs                          # all telemetry
//   node scripts/telemetry-report.mjs --since 2026-07-15       # from a date
//   node scripts/telemetry-report.mjs --since day0             # from Telemetry Day 0
//   node scripts/telemetry-report.mjs --game MTG
//   node scripts/telemetry-report.mjs --source pokemon --status provider_unavailable
//   node scripts/telemetry-report.mjs --json                   # structured output
//
// Reads DATABASE_URL from the environment (.env). Point it at whichever
// database you mean to measure — it does not choose for you.

import { createRequire } from "node:module";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// The analysis modules are TypeScript with "@/*" imports; reuse the test
// runner's alias loader rather than maintaining a second resolution scheme.
register("../test/alias-loader.mjs", import.meta.url);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const { analyzeTelemetry } = await import("../src/lib/scanner/telemetry-analysis.ts");
const { formatTelemetryReport } = await import("../src/lib/scanner/telemetry-report.ts");
const { DEV_USER } = await import("../src/lib/auth-dev-bypass.ts");

/** Telemetry Day 0 — the Phase 5.13C truth-boundary deploy. */
const DAY_0 = "2026-07-15T20:25:59Z";

// ─── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log("Usage: node scripts/telemetry-report.mjs [--since <date|day0>] [--until <date>]");
  console.log("       [--game MTG|POKEMON|YUGIOH] [--source scryfall|pokemon|ygoprodeck]");
  console.log("       [--status found|no_candidates|provider_unavailable] [--json]");
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

const filter = {
  from: parseDate(flag("since"), "since"),
  to: parseDate(flag("until"), "until"),
  game: flag("game"),
  source: flag("source"),
  status: flag("status"),
};

// ─── Load ────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

const createdAtWindow =
  filter.from || filter.to
    ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } }
    : {};

// ─── Development rows are NOT collector scans ────────────────────────────────
// DEV_AUTH_BYPASS writes real rows under a fixed userId (see auth-dev-bypass.ts).
// They are genuine records of something, but they are not a collector scanning a
// card, so they must never sit in a denominator that Phase 5.15 reads as real
// usage. They are EXCLUDED here and COUNTED separately: silently dropping them
// would be its own dishonesty — the reader cannot judge a sample they are not
// told about. Same treatment as legacy raw-OCR rows below.
const devScans = await prisma.scanHistory.count({
  where: { userId: DEV_USER.id, ocrText: { not: null }, ...createdAtWindow },
});

// Fetch by the DB's own createdAt window where we can — the rest of the filters
// need the parsed JSON, so they are applied in analyzeTelemetry.
const rows = await prisma.scanHistory.findMany({
  where: {
    ocrText: { not: null },
    userId: { not: DEV_USER.id },
    ...createdAtWindow,
  },
  select: { ocrText: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});

// ScanHistory.ocrText holds versioned telemetry JSON for post-5.2.5 scans, but
// older rows hold RAW OCR TEXT — the column's original purpose. Those are not
// corrupt telemetry, they are a different thing that predates telemetry, and
// counting them as scans would understate every coverage denominator. Skip and
// report them separately.
const samples = [];
let legacyRawOcr = 0;
let unparseable = 0;

for (const row of rows) {
  let parsed;
  try {
    parsed = JSON.parse(row.ocrText);
  } catch {
    legacyRawOcr++;
    continue;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) {
    unparseable++;
    continue;
  }
  samples.push({ at: row.createdAt, telemetry: parsed });
}

const analysis = analyzeTelemetry(samples, filter);

if (has("json")) {
  console.log(JSON.stringify({ analysis, skipped: { legacyRawOcr, unparseable, devScans } }, null, 2));
} else {
  console.log(formatTelemetryReport(analysis));
  console.log("Source rows");
  console.log("───────────");
  console.log(`  ScanHistory rows read      ${rows.length}`);
  console.log(`  v1 telemetry records       ${samples.length}`);
  console.log(`  legacy raw OCR text        ${legacyRawOcr}   (pre-telemetry rows; not scans we can analyze)`);
  console.log(`  unrecognized shape         ${unparseable}`);
  console.log(`  development rows excluded  ${devScans}   (userId "${DEV_USER.id}" — DEV_AUTH_BYPASS, not collector scans)`);
  if (filter.from) console.log(`\n  Filtered from ${filter.from.toISOString()}${flag("since") === "day0" ? " (Telemetry Day 0)" : ""}`);
}

await prisma.$disconnect();
