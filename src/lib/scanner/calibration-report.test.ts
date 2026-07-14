// Calibration report formatter tests (Phase 5.7).
//
// These lock the RENDERING contract of the calibration notebook helper, not any
// evidence weight. The signal arrays here are hand-built purely to exercise
// formatting (signed contributions, column alignment, optional note) — they are
// not card fixtures and assert nothing about identification behavior.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/calibration-report.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  formatCalibrationReport,
  signalContribution,
  type CalibrationCase,
} from "@/lib/scanner/calibration-report";
import { EVIDENCE_WEIGHTS, type EvidenceSignal, type EvidenceState } from "@/lib/scanner/evidence";

function sig(type: EvidenceSignal["type"], state: EvidenceState): EvidenceSignal {
  // availability is irrelevant to rendering; these hand-built signals only
  // exercise the formatter, which reads type/state/weight (Phase 5.10).
  return { type, state, weight: EVIDENCE_WEIGHTS[type], availability: "supported" };
}

describe("signalContribution", () => {
  test("match adds weight, mismatch subtracts it, unknown is neutral", () => {
    assert.equal(signalContribution(sig("collectorNumber", "match")), 2.0);
    assert.equal(signalContribution(sig("collectorNumber", "mismatch")), -2.0);
    assert.equal(signalContribution(sig("collectorNumber", "unknown")), 0);
  });
});

describe("formatCalibrationReport", () => {
  const base: CalibrationCase = {
    game: "MTG",
    fixture: "Lightning Bolt SOS wrong CN",
    signals: [
      sig("name", "match"),
      sig("setCode", "match"),
      sig("collectorNumber", "mismatch"),
      sig("rarity", "match"),
      sig("artwork", "match"),
    ],
    humanExpectation: "Reject wrong printing",
    calibrationNote: "collectorNumber contradiction may need review",
  };

  test("renders header, signed signal rows, total, expectation and note", () => {
    const report = formatCalibrationReport(base);

    assert.match(report, /^MTG Evidence Calibration Report/);
    assert.match(report, /Fixture:\nLightning Bolt SOS wrong CN/);
    // Signed contributions per signal.
    assert.match(report, /name {2,}MATCH {2,}\+1\.5/);
    assert.match(report, /collectorNumber +MISMATCH {2,}-2\.0/);
    assert.match(report, /artwork {2,}MATCH {2,}\+2\.5/);
    // Total = 1.5 + 1.5 - 2.0 + 0.5 + 2.5 = 4.0
    assert.match(report, /Total:\n\+4\.0/);
    assert.match(report, /Human expectation:\nReject wrong printing/);
    assert.match(report, /Calibration note:\ncollectorNumber contradiction may need review/);
  });

  test("omits the calibration-note block when none is given", () => {
    const { calibrationNote, ...noNote } = base;
    void calibrationNote;
    const report = formatCalibrationReport(noNote);
    assert.ok(!report.includes("Calibration note:"), "no note block when note is absent");
  });

  test("unknown signals render a 0.0 contribution", () => {
    const report = formatCalibrationReport({
      ...base,
      signals: [sig("name", "match"), sig("setCode", "unknown")],
      calibrationNote: undefined,
    });
    assert.match(report, /setCode +UNKNOWN {2,}0\.0/);
  });
});
