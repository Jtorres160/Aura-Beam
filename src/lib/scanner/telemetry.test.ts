// Scan telemetry tests (Phase 5.5, Batch 3 → calibration prep).
//
// These lock in the contract that telemetry is OBSERVATIONAL: it records what
// the pipeline saw and decided, and — new here — the exact EvidenceSignal array
// that produced EvidenceMass, so future calibration can weigh each signal
// against ground truth. The invariants:
//
//   • buildScanTelemetry captures the signals VERBATIM from the scorer. It does
//     not recompute them and adds no derived "winning signal" fields.
//   • The record stays backwards compatible: v is still 1, and older shapes
//     (no evidenceSignals) round-trip through withSelection untouched.
//   • Building telemetry changes no decision, no ranking, no EvidenceMass.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/telemetry.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildScanTelemetry, withSelection } from "@/lib/scanner/telemetry";
import {
  assessIdentitySignals,
  calculateEvidenceMass,
  reading,
  type CandidatePrinting,
  type ScanEvidence,
} from "@/lib/scanner/evidence";
import { acceptDecision, disambiguateDecision, type Decision } from "@/lib/scanner/decision";
import { HeuristicScorer, type ScoreOutput } from "@/lib/scanner/score";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Counterspell",
    game: "MTG",
    setName: "Modern Horizons 2",
    setCode: "mh2",
    collectorNumber: "267",
    rarity: "uncommon",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: "illo-a",
    ...over,
  };
}

function evidence(over: {
  name?: string;
  setCode?: string;
  collectorNumber?: string;
  rarity?: string;
  illustrationId?: string;
}): ScanEvidence {
  return {
    identity: {
      name: over.name !== undefined ? reading(over.name, 0.9, "ocr-full") : undefined,
    },
    printing: {
      setCode: over.setCode !== undefined ? reading(over.setCode, 0.9, "ocr-strip") : undefined,
      collectorNumber:
        over.collectorNumber !== undefined ? reading(over.collectorNumber, 0.9, "ocr-strip") : undefined,
      rarity: over.rarity !== undefined ? reading(over.rarity, 0.9, "ocr-strip") : undefined,
      illustrationId:
        over.illustrationId !== undefined ? reading(over.illustrationId, 0.9, "vision-compare") : undefined,
    },
  };
}

/** Build a ScoreOutput as the scorer would, for a chosen printing. */
function scored(ev: ScanEvidence, chosen: CandidatePrinting, decision: Decision): ScoreOutput {
  const signals = assessIdentitySignals(ev, chosen);
  return {
    decision,
    confidence: decision.confidence,
    margin: decision.action === "accept" ? 1 : 0,
    evidenceMass: calculateEvidenceMass(signals),
    evidenceSignals: signals,
    methodLabel: decision.method ?? decision.action,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  EvidenceSignals appear in telemetry
// ═══════════════════════════════════════════════════════════════════════════

describe("telemetry — EvidenceSignal capture", () => {
  test("includes the exact signal array the scorer produced", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267", illustrationId: "illo-a" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({
      evidence: ev,
      scored: out,
      decision,
      printingsCount: 3,
    });

    // Captured verbatim — same reference the scorer computed, not recomputed.
    assert.equal(t.evidenceSignals, out.evidenceSignals);
    assert.deepEqual(t.evidenceSignals, assessIdentitySignals(ev, chosen));
  });

  test("each signal carries type, state and weight — and nothing derived", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267", illustrationId: "illo-a" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 3 });

    for (const s of t.evidenceSignals ?? []) {
      assert.deepEqual(Object.keys(s).sort(), ["state", "type", "weight"]);
    }
    // No derived analysis fields leak in (winningSignal, strongestEvidence, …).
    assert.equal("winningSignal" in t, false);
    assert.equal("strongestEvidence" in t, false);
  });

  test("recorded signals reconstruct the recorded evidenceMass", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 3 });

    assert.equal(calculateEvidenceMass(t.evidenceSignals ?? []), t.decision.evidenceMass);
  });

  test("mismatch and unknown states survive into telemetry intact", () => {
    // Wrong set code (mismatch) + no illustration read (unknown artwork).
    const chosen = printing({ externalId: "a", illustrationId: "illo-a" });
    const ev = evidence({ name: "Counterspell", setCode: "xxx", collectorNumber: "267" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 3 });
    const byType = Object.fromEntries((t.evidenceSignals ?? []).map((s) => [s.type, s.state]));

    assert.equal(byType.setCode, "mismatch");
    assert.equal(byType.artwork, "unknown");
    assert.equal(byType.collectorNumber, "match");
  });

  test("disambiguation carries an empty signal array (no chosen printing)", () => {
    const candidates = [printing({ externalId: "a" }), printing({ externalId: "b", illustrationId: "illo-b" })];
    const ev = evidence({ name: "Counterspell" });
    const decision = disambiguateDecision(candidates);
    const out: ScoreOutput = {
      decision,
      confidence: 0,
      margin: 0,
      evidenceMass: 0,
      evidenceSignals: [],
      methodLabel: "disambiguate",
    };

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 2 });
    assert.deepEqual(t.evidenceSignals, []);
    assert.equal(t.decision.evidenceMass, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Backwards compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe("telemetry — backwards compatibility", () => {
  test("version stays 1 and existing fields are unchanged", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({
      evidence: ev,
      scored: out,
      decision,
      printingsCount: 3,
      game: "MTG",
      isAutoScan: false,
    });

    assert.equal(t.v, 1);
    assert.equal(t.decision.action, "accept");
    assert.equal(t.decision.method, "set-cn-verified");
    assert.equal(t.printingsCount, 3);
    assert.equal(t.presentedCount, 1);
    assert.equal(t.game, "MTG");
    // Round-trips through JSON as it is persisted.
    const roundTripped = JSON.parse(JSON.stringify(t));
    assert.deepEqual(roundTripped.evidenceSignals, t.evidenceSignals);
  });

  test("withSelection preserves evidenceSignals on an existing record", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267" });
    const decision = disambiguateDecision([chosen, printing({ externalId: "b", illustrationId: "illo-b" })]);
    const out = scored(ev, chosen, { ...decision, printing: chosen });

    const raw = JSON.stringify(buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 2 }));
    const updated = JSON.parse(withSelection(raw, { externalId: "a", game: "MTG" }));

    assert.ok(Array.isArray(updated.evidenceSignals));
    assert.equal(updated.selection.externalId, "a");
    assert.equal(updated.v, 1);
  });

  test("withSelection still writes a minimal v:1 record for corrupt input", () => {
    const updated = JSON.parse(withSelection("{not json", { externalId: "z" }));
    assert.equal(updated.v, 1);
    assert.equal(updated.selection.externalId, "z");
    assert.equal(updated.evidenceSignals, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Building telemetry is a read-only observation
// ═══════════════════════════════════════════════════════════════════════════

describe("telemetry — observation does not mutate the pipeline", () => {
  test("the scorer's EvidenceMass is unchanged by telemetry capture", async () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267", illustrationId: "illo-a" });

    const out = await new HeuristicScorer().score({
      cardName: "Counterspell",
      printings: [chosen],
      fallbackCard: null,
      evidence: ev,
      scannedImageUrl: "https://example/scan.png",
      learningRule: null,
    });

    const massBefore = out.evidenceMass;
    const signalsBefore = JSON.stringify(out.evidenceSignals);

    buildScanTelemetry({ evidence: ev, scored: out, decision: out.decision, printingsCount: 1 });

    assert.equal(out.evidenceMass, massBefore);
    assert.equal(JSON.stringify(out.evidenceSignals), signalsBefore);
    // Independent recompute matches — capture didn't alter the signals.
    assert.equal(calculateEvidenceMass(assessIdentitySignals(ev, chosen)), massBefore);
  });
});
