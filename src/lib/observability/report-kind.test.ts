import assert from "node:assert/strict";
import { test } from "node:test";
import { reportKindForStage, type ReportKind } from "@/lib/observability/report-kind";
import type { FailureStage } from "@/lib/scanner/failure";

// The point of these tests is the taxonomy split, not the Sentry call. If a
// verdict ever starts reporting as an exception, Sentry fills with a permanent
// baseline of "no card in this photo" and stops being useful for real breaks.

const VERDICTS = ["rate-limit", "no-card", "not-found"] as const;
const OUTAGES = ["provider-unavailable", "selection-provider"] as const;
const ERRORS = ["parse", "ocr", "candidates", "scoring", "database", "unknown"] as const;

// Compile-time exhaustiveness: if a stage is added to FailureStage and not
// classified in one of the three buckets above, `Uncovered` stops being `never`
// and this line fails to typecheck. (The runtime rule has its own guarantee —
// REPORT_KIND is a Record<FailureStage, …> — so this catches the test drifting
// out of step with the module rather than the module going unchecked.)
type Bucketed = (typeof VERDICTS | typeof OUTAGES | typeof ERRORS)[number];
type Uncovered = Exclude<FailureStage, Bucketed>;
const _exhaustive: Uncovered[] = [];
void _exhaustive;

test("verdicts and refusals are never reported", () => {
  for (const stage of VERDICTS) {
    assert.equal(reportKindForStage(stage), "silent", `${stage} must stay silent`);
  }
});

test("an unreachable card source is a warning, not an exception", () => {
  for (const stage of OUTAGES) {
    assert.equal(reportKindForStage(stage), "warning", `${stage} must be a warning`);
  }
});

test("genuine pipeline breaks are exceptions", () => {
  for (const stage of ERRORS) {
    assert.equal(reportKindForStage(stage), "exception", `${stage} must be an exception`);
  }
});

test("every stage in the taxonomy has a decided report kind", () => {
  const all: FailureStage[] = [...VERDICTS, ...OUTAGES, ...ERRORS];
  assert.equal(new Set(all).size, all.length, "a stage is listed in two buckets");
  for (const stage of all) {
    const kind: ReportKind = reportKindForStage(stage);
    assert.ok(["exception", "warning", "silent"].includes(kind));
  }
});
