// Capture rejection taxonomy + pre-scorer failure telemetry (Phase 5.14.3).
//
// These lock in the truth-layer contract for the two stages that previously
// left NO record at all — capture (client-side, never reached the server) and
// extraction (returned early before any write):
//
//   • The taxonomy names MEASUREMENTS, never conclusions. No "bad scan",
//     no "ai_error", no "wrong card" — those are verdicts about the user or the
//     model that the gate is in no position to make.
//   • An unrecognized reason is REJECTED, never coerced into a bucket.
//   • A failed OCR CALL and a frame with NO CARD in it stay distinguishable
//     forever. Collapsing them blames the collector's photo for our outage.
//   • Pre-scorer failure records never invent a decision, a confidence or a
//     candidate count for stages that did not run.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/capture-rejection.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_FAILURE_REASONS,
  CAPTURE_MODES,
  isCaptureFailureReason,
  isCaptureMode,
} from "@/lib/scanner/capture-rejection";
import { buildFailureTelemetry } from "@/lib/scanner/telemetry";

describe("capture rejection taxonomy", () => {
  test("every reason names a measured property of the frame, not a conclusion", () => {
    // The forbidden vocabulary from the Aura truth boundary: each of these is a
    // judgement (about the model, the user, or the card) rather than something
    // the quality gate actually measured.
    const conclusions = ["bad", "wrong", "fail", "error", "ai", "poor", "user"];
    for (const reason of CAPTURE_FAILURE_REASONS) {
      for (const word of conclusions) {
        assert.ok(
          !reason.includes(word),
          `Capture reason "${reason}" contains "${word}" — that is a conclusion, not a measurement.`
        );
      }
    }
  });

  test("accepts exactly the gate's own vocabulary", () => {
    for (const reason of CAPTURE_FAILURE_REASONS) {
      assert.ok(isCaptureFailureReason(reason));
    }
    for (const mode of CAPTURE_MODES) {
      assert.ok(isCaptureMode(mode));
    }
  });

  test("an unrecognized reason is rejected, not coerced into a bucket", () => {
    // A value we cannot interpret must not be stored: it would pollute the
    // reason distribution with a bucket that means nothing.
    for (const bogus of ["bad-scan", "unknown", "", null, undefined, 42, {}]) {
      assert.equal(isCaptureFailureReason(bogus), false, `should reject ${JSON.stringify(bogus)}`);
    }
    for (const bogus of ["bulk", "", null, 7]) {
      assert.equal(isCaptureMode(bogus), false, `should reject ${JSON.stringify(bogus)}`);
    }
  });
});

describe("pre-scorer failure telemetry", () => {
  test("a failed OCR CALL and a frame with NO CARD are different records", () => {
    // The distinction this whole phase turns on. "The reader broke" and "the
    // reader worked and saw no card" must never converge, or an outage reads as
    // the collector having photographed nothing.
    const ocrBroke = buildFailureTelemetry({
      stage: "ocr",
      extractionStatus: "failed",
      errorMessage: "upstream timeout",
      game: "MTG",
    });
    const noCard = buildFailureTelemetry({
      stage: "no-card",
      extractionStatus: "no_card",
      game: "MTG",
    });

    assert.equal(ocrBroke.extractionStatus, "failed");
    assert.equal(noCard.extractionStatus, "no_card");
    assert.notEqual(ocrBroke.failureStage, noCard.failureStage);
  });

  test("a verdict carries no error; an error carries the reader's own message", () => {
    // no-card is an OUTCOME, not an error — attaching an error to it would
    // manufacture a fault that never occurred.
    const noCard = buildFailureTelemetry({ stage: "no-card", extractionStatus: "no_card" });
    assert.equal(noCard.error, undefined);

    const failed = buildFailureTelemetry({ stage: "ocr", extractionStatus: "failed", errorMessage: "boom" });
    assert.deepEqual(failed.error, { stage: "ocr", message: "boom" });
  });

  test("never invents a decision, confidence or candidate count for stages that never ran", () => {
    // The fabrication this shape exists to prevent: a `printingsCount: 0` here
    // would be a measurement of a scorer that was never called — indistinguishable
    // from a real scan that genuinely found zero printings.
    const rec = buildFailureTelemetry({ stage: "ocr", extractionStatus: "failed", errorMessage: "x" });
    const keys = Object.keys(rec).filter((k) => rec[k as keyof typeof rec] !== undefined);

    for (const forbidden of ["decision", "confidence", "printingsCount", "candidateStatus", "evidence"]) {
      assert.ok(!keys.includes(forbidden), `failure telemetry must not carry "${forbidden}"`);
    }
  });

  test("an unmeasured field is absent, never zero or a guess", () => {
    // Scanned with the "All" filter and no timings recorded: those are unknown,
    // and unknown must not render as a value.
    const rec = buildFailureTelemetry({ stage: "parse", errorMessage: "no image" });
    assert.equal(rec.game, undefined);
    assert.equal(rec.timings, undefined);
    assert.equal(rec.extractionStatus, undefined, "parse died before extraction — status is unknown, not 'failed'");
  });

  test("stays v1 and JSON-round-trips (existing readers are unaffected)", () => {
    const rec = buildFailureTelemetry({
      stage: "no-card",
      extractionStatus: "no_card",
      game: "POKEMON",
      isAutoScan: true,
      timings: { ocrMs: 1200 },
    });
    assert.equal(rec.v, 1);

    const parsed = JSON.parse(JSON.stringify(rec));
    assert.equal(parsed.v, 1);
    assert.equal(parsed.failureStage, "no-card");
    assert.equal(parsed.extractionStatus, "no_card");
    assert.deepEqual(parsed.timings, { ocrMs: 1200 });
  });
});
