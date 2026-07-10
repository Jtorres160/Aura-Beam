// ─── TEMPORARY · DEV-ONLY · SmartCapture Diagnostics Analyzer ────────────────
// Companion to src/lib/scanner/smart-diagnostics.ts (Phase 4.5 auto/bulk stall
// debug). Feed it the JSON exported from the phone via the "⤓ Export
// SmartCapture Diag" button and it answers the calibration questions directly:
//
//   • Why was the frame not ready?  (reason histogram)
//   • What were the real metric values on THIS device? (percentiles per metric)
//   • Did readiness ever hold long enough? (ready streaks vs the dwell)
//   • What reset the dwell each time it started? (candidate_reset reasons)
//
// Usage:  node scripts/analyze-smart-diag.mjs path/to/aura-smartcapture-debug.json
//
// Standalone, zero dependencies, touches nothing in src/.
// TO REMOVE: delete this file with the rest of the Phase 4.5 diagnostics.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/analyze-smart-diag.mjs <aura-smartcapture-debug.json>");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(path, "utf8"));
const events = payload.events ?? [];
if (events.length === 0) {
  console.log("No events in export — was the camera opened in Auto/Bulk mode in a dev build?");
  process.exit(0);
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const fmt = (n) => (n === null || n === undefined ? "—" : typeof n === "number" ? +n.toFixed(2) : n);

console.log(`Export: ${payload.eventCount} events · session ${payload.sessionStartedAt}`);
console.log(`Device: ${payload.userAgent}`);
console.log(`Thresholds in build: ${JSON.stringify(events.find((e) => e.thresholds)?.thresholds)}\n`);

// ── 1. Event + reason histograms ────────────────────────────────────────────
const count = (arr, key) =>
  arr.reduce((m, e) => ((m[key(e) ?? "—"] = (m[key(e) ?? "—"] ?? 0) + 1), m), {});
const table = (title, obj) => {
  console.log(title);
  for (const [k, v] of Object.entries(obj).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  console.log();
};
table("Events:", count(events, (e) => e.event));
table("Not-ready reasons (heartbeats + readiness changes):",
  count(events.filter((e) => (e.event === "heartbeat" || e.event === "readiness_change") && e.ready === false), (e) => e.reason));
table("Dwell resets — which metric killed the stability timer:",
  count(events.filter((e) => e.event === "candidate_reset"), (e) => e.reason));

// ── 2. Metric percentiles across every sampled event ────────────────────────
console.log("Metric distributions (all events carrying metrics):");
for (const metric of ["motion", "sharpness", "glare", "brightness"]) {
  const vals = events.map((e) => e.metrics?.[metric]).filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!vals.length) continue;
  console.log(
    `  ${metric.padEnd(10)} n=${String(vals.length).padStart(4)}  ` +
    `min=${fmt(vals[0])}  p25=${fmt(pct(vals, 25))}  p50=${fmt(pct(vals, 50))}  ` +
    `p75=${fmt(pct(vals, 75))}  p90=${fmt(pct(vals, 90))}  max=${fmt(vals.at(-1))}`
  );
}
console.log();

// ── 3. Ready streaks vs the dwell requirement ───────────────────────────────
// Reconstruct how long `ready` held continuously, from the event stream.
const sampled = events.filter((e) => typeof e.ready === "boolean" && typeof e.tMs === "number");
let streaks = [];
let start = null;
for (const e of sampled) {
  if (e.ready) start ??= e.tMs;
  else if (start !== null) { streaks.push(e.tMs - start); start = null; }
}
if (start !== null && sampled.length) streaks.push(sampled.at(-1).tMs - start);
streaks.sort((a, b) => b - a);
const required = events.find((e) => e.requiredDwellMs)?.requiredDwellMs ?? 500;
console.log(`Continuous-ready streaks (dwell requires ${required}ms):`);
console.log(streaks.length
  ? `  count=${streaks.length}  longest=${Math.round(streaks[0])}ms  ` +
    `median=${Math.round(streaks[Math.floor(streaks.length / 2)])}ms  ` +
    `>=dwell: ${streaks.filter((s) => s >= required).length}`
  : "  frame was NEVER ready — see the reason histogram above.");
console.log();

// ── 4. Did the pipeline ever get past the gate? ─────────────────────────────
for (const marker of ["capture_triggered", "capture_best_frame_called", "capture_result", "ocr_dispatch"]) {
  const n = events.filter((e) => e.event === marker).length;
  console.log(`  ${marker.padEnd(26)} ${n > 0 ? `reached ×${n}` : "NEVER reached"}`);
}
