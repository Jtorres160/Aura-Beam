// Telemetry Interpretation tests (Phase 5.15).
//
// These lock the ONE distinction this layer exists to make and the analysis
// layer could not:
//
//   "the stage never ran"  ≠  "the stage ran and we didn't record the result"
//   (not_executed)              (unknown)
//
// Both were `outcomes.unclassified` before. Collapsing them is the absent-as-zero
// error one level up, so every test that could let them merge is a defect probe.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/telemetry-interpretation.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAttempt,
  interpretAttempts,
  recordKind,
  stageExecution,
  ATTEMPT_CATEGORIES,
  PIPELINE_STAGES,
  type AttemptCategory,
} from "@/lib/scanner/telemetry-interpretation";
import { formatAttemptInterpretation } from "@/lib/scanner/telemetry-report";
import { buildFailureTelemetry } from "@/lib/scanner/telemetry";
import type { ScanTelemetryV1 } from "@/lib/scanner/telemetry";

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Hand-built to match the three shapes the route actually writes.

function scored(over: Partial<ScanTelemetryV1> = {}): ScanTelemetryV1 {
  return {
    v: 1,
    evidence: {} as ScanTelemetryV1["evidence"],
    decision: { action: "accept", confidence: 0.9, margin: 0.3, evidenceMass: 2 },
    printingsCount: 1,
    presentedCount: 1,
    ...over,
  };
}

/** The route's catch-all row: an escaped stage and nothing else. */
function errorRow(stage: string, message = "boom") {
  return { v: 1 as const, error: { stage, message }, timings: { ocrMs: 10 } };
}

// ─── recordKind ──────────────────────────────────────────────────────────────

describe("recordKind — structural discrimination of the three shapes", () => {
  test("a decision object marks a scored record", () => {
    assert.equal(recordKind(scored()), "scored");
  });

  test("a failureStage marks a failure record", () => {
    assert.equal(recordKind(buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" })), "failure");
  });

  test("a bare error object marks the catch-all row", () => {
    assert.equal(recordKind(errorRow("database")), "error");
  });

  test("a corrupt selection-only row is named, not misread as scored", () => {
    assert.equal(recordKind({ v: 1, selection: { externalId: "x", at: "t" } }), "selection_only");
  });

  test("anything unreadable is unrecognized, never a throw", () => {
    assert.equal(recordKind(null), "unrecognized");
    assert.equal(recordKind(42), "unrecognized");
    assert.equal(recordKind({ v: 1 }), "unrecognized");
  });
});

// ─── classifyAttempt ─────────────────────────────────────────────────────────

describe("classifyAttempt — one vocabulary across all shapes", () => {
  test("candidateStatus drives the scored outcomes", () => {
    assert.equal(classifyAttempt(scored({ candidateStatus: "found" })), "found");
    assert.equal(classifyAttempt(scored({ candidateStatus: "no_candidates" })), "no_match");
    assert.equal(classifyAttempt(scored({ candidateStatus: "provider_unavailable" })), "provider_unavailable");
  });

  test("a scored record with NO candidateStatus is unclassified — never a miss", () => {
    // This is the pre-5.13C row. Its candidate stage ran; the verdict just wasn't
    // stored. Calling it no_match would fabricate an absence.
    assert.equal(classifyAttempt(scored({})), "unclassified");
  });

  test("no_card and ocr failure are different categories, not one 'OCR problem'", () => {
    assert.equal(classifyAttempt(buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" })), "no_card");
    assert.equal(
      classifyAttempt(buildFailureTelemetry({ stage: "ocr", extractionStatus: "failed", errorMessage: "timeout" })),
      "ocr_failed",
    );
  });

  test("failure stages map to their own categories", () => {
    assert.equal(classifyAttempt(buildFailureTelemetry({ stage: "parse", errorMessage: "no image" })), "parse_failed");
    assert.equal(classifyAttempt(errorRow("candidates")), "candidate_search_failed");
    assert.equal(classifyAttempt(errorRow("scoring")), "scoring_failed");
    assert.equal(classifyAttempt(errorRow("database")), "database_failed");
    assert.equal(classifyAttempt(errorRow("unknown")), "error_other");
  });
});

// ─── stageExecution — the load-bearing distinction ───────────────────────────

describe("stageExecution — 'not run' is an absence, not a failure", () => {
  test("a no-card attempt ran parse+ocr and executed NOTHING after", () => {
    const s = stageExecution(buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" }));
    assert.equal(s.parse, "ran_ok");
    assert.equal(s.ocr, "ran_empty", "the reader ran and honestly saw no card");
    assert.equal(s.candidates, "not_executed");
    assert.equal(s.scoring, "not_executed");
    assert.equal(s.decision, "not_executed");
  });

  test("an ocr FAILURE marks ocr failed, not empty — the reader broke, it didn't read", () => {
    const s = stageExecution(buildFailureTelemetry({ stage: "ocr", extractionStatus: "failed", errorMessage: "x" }));
    assert.equal(s.ocr, "ran_failed");
    assert.equal(s.candidates, "not_executed");
  });

  test("a pre-5.13C scored record: candidates is UNKNOWN, never not_executed", () => {
    // The crux. The candidate stage DID run — we just didn't store the verdict.
    // Marking it not_executed would claim the scanner skipped a stage it ran.
    const s = stageExecution(scored({}));
    assert.equal(s.candidates, "unknown");
    assert.notEqual(s.candidates, "not_executed");
    assert.equal(s.scoring, "ran_ok");
    assert.equal(s.decision, "ran_ok");
  });

  test("candidateStatus resolves the candidate stage on scored records", () => {
    assert.equal(stageExecution(scored({ candidateStatus: "found" })).candidates, "ran_ok");
    assert.equal(stageExecution(scored({ candidateStatus: "no_candidates" })).candidates, "ran_empty");
    assert.equal(stageExecution(scored({ candidateStatus: "provider_unavailable" })).candidates, "ran_failed");
  });

  test("a candidate-stage throw fails candidates and leaves scoring/decision unrun", () => {
    const s = stageExecution(errorRow("candidates"));
    assert.equal(s.ocr, "ran_ok");
    assert.equal(s.candidates, "ran_failed");
    assert.equal(s.scoring, "not_executed");
    assert.equal(s.decision, "not_executed");
  });

  test("a database throw is position-ambiguous, so every stage is unknown — not a guess", () => {
    const s = stageExecution(errorRow("database"));
    for (const stage of PIPELINE_STAGES) {
      assert.equal(s[stage], "unknown", `${stage} must not assert a position the record can't support`);
    }
  });
});

// ─── Aggregation ─────────────────────────────────────────────────────────────

describe("interpretAttempts — a census over every record shape", () => {
  test("total counts every record; byKind splits the shapes", () => {
    const i = interpretAttempts([
      scored({ candidateStatus: "found" }),
      scored({ candidateStatus: "no_candidates" }),
      buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" }),
      errorRow("database"),
      null,
    ]);
    assert.equal(i.total, 5);
    assert.equal(i.byKind.scored, 2);
    assert.equal(i.byKind.failure, 1);
    assert.equal(i.byKind.error, 1);
    assert.equal(i.byKind.unrecognized, 1);
  });

  test("failure attempts and pre-5.13C records land in DIFFERENT buckets", () => {
    // The whole point: before this layer both were 'unclassified'. A no-card
    // (never reached candidates) and a legacy scored row (reached it, unrecorded)
    // must not be summed together.
    const i = interpretAttempts([
      scored({}), // pre-5.13C: unclassified
      buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" }), // no_card
    ]);
    assert.equal(i.byCategory.unclassified, 1);
    assert.equal(i.byCategory.no_card, 1);
    // And the candidate stage saw one 'unknown' (the legacy row) and one
    // 'not run' (the no-card) — never two of the same.
    assert.equal(i.stages.candidates.unknown, 1);
    assert.equal(i.stages.candidates.not_executed, 1);
  });

  test("every stage's states sum to the record total — 'not run' is quantified, not hidden", () => {
    const records = [
      scored({ candidateStatus: "found" }),
      buildFailureTelemetry({ stage: "parse", errorMessage: "no image" }),
      errorRow("candidates"),
    ];
    const i = interpretAttempts(records);
    for (const stage of PIPELINE_STAGES) {
      const counts = i.stages[stage];
      const sum = Object.values(counts).reduce((a: number, b: number) => a + b, 0);
      assert.equal(sum, records.length, `${stage} counts must account for every attempt`);
    }
  });

  test("an empty input claims nothing", () => {
    const i = interpretAttempts([]);
    assert.equal(i.total, 0);
    for (const c of ATTEMPT_CATEGORIES) assert.equal(i.byCategory[c as AttemptCategory], 0);
  });
});

// ─── Rendering ───────────────────────────────────────────────────────────────

describe("formatAttemptInterpretation — descriptive, never a verdict", () => {
  test("a 'not run' stage renders as 'not run', never as a failure or a zero-latency", () => {
    const report = formatAttemptInterpretation(
      interpretAttempts([buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" })]),
    );
    assert.match(report, /not run/, "stages the attempt skipped must read as not run");
    assert.doesNotMatch(report, /0ms/, "interpretation counts attempts, never fabricates a latency");
  });

  test("categories carry their definitions so the reader needn't read the code", () => {
    const report = formatAttemptInterpretation(interpretAttempts([scored({ candidateStatus: "found" })]));
    assert.match(report, /found/);
    assert.match(report, /identified a printing/, "each category prints its plain-language meaning");
  });

  test("absent categories are not printed as zero rows", () => {
    const report = formatAttemptInterpretation(interpretAttempts([scored({ candidateStatus: "found" })]));
    // Only 'found' occurred; no_match/no_card/etc must not appear as 0 lines.
    assert.doesNotMatch(report, /no_match\s+0/);
    assert.doesNotMatch(report, /parse_failed/);
  });

  test("an empty census says so and claims nothing", () => {
    const report = formatAttemptInterpretation(interpretAttempts([]));
    assert.match(report, /Records: 0/);
    assert.match(report, /no stored records/);
  });
});
