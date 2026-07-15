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

import { buildScanTelemetry, withSelection, withSelectionAttempt } from "@/lib/scanner/telemetry";
import { CANDIDATE_SOURCE_LABELS, type CandidateSourceStatus } from "@/lib/scanner/candidates";
import {
  assessIdentitySignals,
  calculateEvidenceMass,
  calculateEvidenceCoverage,
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
    evidenceCoverage: calculateEvidenceCoverage(signals),
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

  test("each signal carries type, state, weight and availability — and nothing derived", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267", illustrationId: "illo-a" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 3 });

    for (const s of t.evidenceSignals ?? []) {
      // availability joins the signal shape in Phase 5.10 — it is descriptive
      // (supported/unavailable/failed), NOT a derived confidence field.
      assert.deepEqual(Object.keys(s).sort(), ["availability", "state", "type", "weight"]);
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

  test("captures evidenceCoverage verbatim alongside the signals (Phase 5.10)", () => {
    const chosen = printing({ externalId: "a" }); // MTG candidate (rarity "uncommon")
    const ev = evidence({
      name: "Counterspell",
      setCode: "mh2",
      collectorNumber: "267",
      rarity: "uncommon",
      illustrationId: "illo-a",
    });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 3 });

    // Same reference the scorer produced — not recomputed here.
    assert.equal(t.evidenceCoverage, out.evidenceCoverage);
    // MTG full-read: five expected sensors, all present.
    assert.deepEqual(t.evidenceCoverage, { expected: 5, present: 5, failed: 0, unavailable: 0, total: 5 });
  });

  test("disambiguation omits evidenceCoverage (no chosen printing)", () => {
    const candidates = [printing({ externalId: "a" }), printing({ externalId: "b", illustrationId: "illo-b" })];
    const ev = evidence({ name: "Counterspell" });
    const decision = disambiguateDecision(candidates);
    const out: ScoreOutput = {
      decision,
      confidence: 0,
      margin: 0,
      evidenceMass: 0,
      evidenceSignals: [],
      evidenceCoverage: calculateEvidenceCoverage([]),
      methodLabel: "disambiguate",
    };

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 2 });
    assert.equal(t.evidenceCoverage, undefined, "no printing assessed → no coverage recorded");
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
      evidenceCoverage: calculateEvidenceCoverage([]),
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

// ═══════════════════════════════════════════════════════════════════════════
//  Candidate source state (Phase 5.13C)
// ═══════════════════════════════════════════════════════════════════════════
//
// Before this, `timings.candidatesMs` was one number covering up to three
// providers and several calls each. It could not answer WHICH source was slow,
// how often we hit the 8s ceiling, or whether a SUCCESSFUL scan had quietly run
// with a source down. That last case left no trace anywhere in the system: a
// scan that found the card while Pokemon timed out was byte-identical, in
// telemetry, to a perfectly healthy scan.
//
// Measurement precedes optimization, so the measurement has to exist first.

function sourceStatus(over: Partial<CandidateSourceStatus> & { source: CandidateSourceStatus["source"] }): CandidateSourceStatus {
  return {
    label: CANDIDATE_SOURCE_LABELS[over.source],
    availability: "completed",
    durationMs: 0,
    ...over,
  };
}

describe("telemetry — candidate source state", () => {
  test("a SUCCESSFUL scan still records a partial provider failure", () => {
    // The invisible case. The card was found (Scryfall answered), but Pokemon
    // was dark the whole time. The scan succeeds — and must still say so.
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell", setCode: "mh2", collectorNumber: "267" });
    const decision = acceptDecision(chosen, "set-cn-verified");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({
      evidence: ev,
      scored: out,
      decision,
      candidates: {
        status: "found",
        sources: [
          sourceStatus({ source: "scryfall", durationMs: 412 }),
          sourceStatus({ source: "pokemon", availability: "failed", reason: "timeout", durationMs: 8003 }),
        ],
      },
      printingsCount: 1,
    });

    assert.equal(t.candidateStatus, "found");
    assert.equal(t.candidateSources?.length, 2);
    const pokemon = t.candidateSources?.find((s) => s.source === "pokemon");
    assert.equal(pokemon?.availability, "failed");
    assert.equal(pokemon?.reason, "timeout");
    assert.equal(pokemon?.durationMs, 8003);
    // And the per-source latency the single candidatesMs number could never show.
    assert.equal(t.candidateSources?.find((s) => s.source === "scryfall")?.durationMs, 412);
  });

  test("candidateStatus, not decision.action, is what counts a true no-match", () => {
    // These two legitimately disagree, and the disagreement used to make the
    // record self-contradictory: a provider_unavailable scan wrote
    // decision.action "not-found" into the JSON while the row's matchMethod
    // said "provider-unavailable". Anyone counting genuine absences off
    // decision.action swept in every outage.
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell" });
    const decision = disambiguateDecision([chosen]);
    const out = scored(ev, chosen, decision);

    const unavailable = buildScanTelemetry({
      evidence: ev,
      scored: { ...out, decision: { action: "not-found", confidence: 0 } },
      decision: { action: "not-found", confidence: 0 },
      candidates: {
        status: "provider_unavailable",
        sources: [sourceStatus({ source: "pokemon", availability: "failed", reason: "timeout", durationMs: 8001 })],
      },
      printingsCount: 0,
    });

    const genuinelyAbsent = buildScanTelemetry({
      evidence: ev,
      scored: { ...out, decision: { action: "not-found", confidence: 0 } },
      decision: { action: "not-found", confidence: 0 },
      candidates: {
        status: "no_candidates",
        sources: [sourceStatus({ source: "scryfall", durationMs: 51 })],
      },
      printingsCount: 0,
    });

    // The scorer's verdict is identical for both — it was handed zero printings
    // either way. That is exactly why it cannot be the field you count.
    assert.equal(unavailable.decision.action, genuinelyAbsent.decision.action);
    // The route's verdict distinguishes them.
    assert.notEqual(unavailable.candidateStatus, genuinelyAbsent.candidateStatus);
    assert.equal(genuinelyAbsent.candidateStatus, "no_candidates");
    assert.equal(unavailable.candidateStatus, "provider_unavailable");
  });

  test("omitting candidates keeps the record valid — older shapes still round-trip", () => {
    const chosen = printing({ externalId: "a" });
    const ev = evidence({ name: "Counterspell" });
    const decision = acceptDecision(chosen, "single-printing");
    const out = scored(ev, chosen, decision);

    const t = buildScanTelemetry({ evidence: ev, scored: out, decision, printingsCount: 1 });

    assert.equal(t.v, 1, "additive fields must not bump the version");
    assert.equal(t.candidateStatus, undefined);
    assert.equal(t.candidateSources, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Failed selection attempts (Phase 5.13C)
// ═══════════════════════════════════════════════════════════════════════════

describe("withSelectionAttempt — a failed save leaves a trace, not a scar", () => {
  test("records the attempt without touching the pending row's other facts", () => {
    const original = JSON.stringify({ v: 1, evidence: { identity: {} }, printingsCount: 4 });
    const after = JSON.parse(withSelectionAttempt(original, {
      status: "provider_unavailable",
      source: "pokemon",
      reason: "timeout",
    }));

    assert.equal(after.printingsCount, 4, "existing evidence must survive");
    assert.equal(after.selectionAttempts.length, 1);
    assert.equal(after.selectionAttempts[0].source, "pokemon");
    assert.equal(after.selectionAttempts[0].reason, "timeout");
    assert.ok(after.selectionAttempts[0].at, "must be timestamped");
  });

  test("attempts accumulate, and a later success still lands its label", () => {
    // The sequence that matters: the user retries against a flapping provider
    // and eventually succeeds. Both failures AND the ground-truth label must
    // survive — the label is what Phase 6 trains on, the failures are what a
    // provider-reliability query counts.
    let raw = JSON.stringify({ v: 1, printingsCount: 4 });
    raw = withSelectionAttempt(raw, { status: "provider_unavailable", source: "pokemon", reason: "timeout" });
    raw = withSelectionAttempt(raw, { status: "provider_unavailable", source: "pokemon", reason: "http_error" });
    raw = withSelection(raw, { externalId: "sv3-125", game: "POKEMON" });

    const after = JSON.parse(raw);
    assert.equal(after.selectionAttempts.length, 2);
    assert.deepEqual(after.selectionAttempts.map((a: any) => a.reason), ["timeout", "http_error"]);
    assert.equal(after.selection.externalId, "sv3-125", "the ground-truth label must survive the failures");
    assert.equal(after.printingsCount, 4);
  });

  test("a corrupt original never loses the attempt", () => {
    const after = JSON.parse(withSelectionAttempt("{not json", {
      status: "provider_unavailable",
      source: "scryfall",
      reason: "network",
    }));
    assert.equal(after.selectionAttempts.length, 1);
    assert.equal(after.selectionAttempts[0].source, "scryfall");
  });
});
