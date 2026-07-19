// Recognition Baseline tests (Scanner V2 · Milestone 0).
//
// These lock the measurement contract: the baseline must count outcomes,
// memory-shadow agreement, repeat scans, ground truth, failure modes and OCR
// cost EXACTLY from the telemetry the route already writes — and, above all,
// must compute the serve-safety verdict correctly, because enabling
// Recognition-Memory serve later hangs on it.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/recognition-baseline.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeRecognitionBaseline,
  formatRecognitionBaseline,
  analyzeArtPickAgreement,
  formatArtPickAgreement,
} from "@/lib/scanner/recognition-baseline";

// ─── Fixtures — the record shapes the scan route actually persists ───────────

function scored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    evidence: {},
    decision: { action: "accept", method: "set-cn-verified", confidence: 0.97, margin: 1, evidenceMass: 2 },
    printingsCount: 1,
    presentedCount: 1,
    ...over,
  };
}

function memoryBlock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "shadow",
    outcome: "hit",
    matchedBy: "set-cn",
    memoryExternalId: "sv3-125",
    agreement: "agree",
    providerSourcesConsulted: 1,
    wouldAvoidProviders: true,
    wouldServe: true,
    ...over,
  };
}

describe("outcome distribution", () => {
  test("counts accepts, disambiguations, and accepts by method + mode", () => {
    const b = analyzeRecognitionBaseline([
      scored({ decision: { action: "accept", method: "set-cn-verified" }, isAutoScan: true }),
      scored({ decision: { action: "accept", method: "single-printing" }, isAutoScan: false }),
      scored({ decision: { action: "disambiguate" } }),
      scored({ decision: { action: "not-found" } }),
    ]);
    assert.equal(b.outcomes.scored, 4);
    assert.equal(b.outcomes.accept, 2);
    assert.equal(b.outcomes.disambiguate, 1);
    assert.equal(b.outcomes.scorerNotFound, 1);
    assert.equal(b.outcomes.autoScanAccepts, 1);
    assert.equal(b.outcomes.interactiveAccepts, 1);
    assert.equal(b.outcomes.acceptsByMethod["set-cn-verified"], 1);
    assert.equal(b.outcomes.acceptsByMethod["single-printing"], 1);
  });
});

describe("recognition-memory serve safety — the gate for enabling serve", () => {
  test("a clean shadow (hits, zero disagreements) is CLEAN", () => {
    const b = analyzeRecognitionBaseline([
      scored({ memory: memoryBlock({ agreement: "agree" }) }),
      scored({ memory: memoryBlock({ agreement: "agree", memoryExternalId: "sv3-1" }) }),
    ]);
    assert.equal(b.memory.observed, 2);
    assert.equal(b.memory.hits, 2);
    assert.equal(b.memory.agreement.agree, 2);
    assert.equal(b.memory.agreement.disagree, 0);
    assert.equal(b.memory.serveSafety, "clean");
  });

  test("a SINGLE disagreement BLOCKS serve and is surfaced for inspection", () => {
    const b = analyzeRecognitionBaseline([
      scored({ memory: memoryBlock({ agreement: "agree" }) }),
      scored({ memory: memoryBlock({ agreement: "disagree", memoryExternalId: "A", pipelineExternalId: "B" }) }),
    ]);
    assert.equal(b.memory.serveSafety, "blocked");
    assert.equal(b.memory.agreement.disagree, 1);
    assert.deepEqual(b.memory.disagreements, [{ memory: "A", pipeline: "B" }]);
  });

  test("no memory observations at all is NO-DATA, never a false all-clear", () => {
    const b = analyzeRecognitionBaseline([scored()]);
    assert.equal(b.memory.observed, 0);
    assert.equal(b.memory.serveSafety, "no-data");
  });

  test("matchedBy and avoidable provider calls are tallied", () => {
    const b = analyzeRecognitionBaseline([
      scored({ memory: memoryBlock({ matchedBy: "set-cn", providerSourcesConsulted: 2, wouldAvoidProviders: true }) }),
      scored({ memory: memoryBlock({ matchedBy: "name", providerSourcesConsulted: 1, wouldAvoidProviders: true }) }),
    ]);
    assert.equal(b.memory.byMatchedBy.setCn, 1);
    assert.equal(b.memory.byMatchedBy.name, 1);
    assert.equal(b.memory.wouldAvoidProviders, 2);
    assert.equal(b.memory.providerCallsAvoidable, 3);
  });
});

describe("repeat scans & resilience", () => {
  test("hits are repeats; memory-only agreements are resilience wins", () => {
    const b = analyzeRecognitionBaseline([
      scored({ memory: memoryBlock({ outcome: "hit", agreement: "agree" }) }),
      scored({ memory: memoryBlock({ outcome: "hit", agreement: "memory-only" }) }),
      scored({ memory: { mode: "shadow", outcome: "miss", agreement: "n/a" } }),
    ]);
    assert.equal(b.repeatScans.repeats, 2);
    assert.equal(b.repeatScans.resilienceWins, 1);
    assert.ok(Math.abs(b.repeatScans.repeatRate - 2 / 3) < 1e-9);
  });
});

describe("ground truth", () => {
  test("counts user selections and selection failures", () => {
    const b = analyzeRecognitionBaseline([
      scored({ selection: { externalId: "sv3-125", at: "2026-07-19T00:00:00Z" } }),
      scored({ selectionAttempts: [{ status: "provider_unavailable", source: "pokemon", reason: "timeout", at: "x" }] }),
      scored(),
    ]);
    assert.equal(b.groundTruth.userSelections, 1);
    assert.equal(b.groundTruth.selectionFailures, 1);
  });
});

describe("failure modes across every record shape", () => {
  test("candidate-layer verdicts: no-card-exists vs provider-unavailable", () => {
    const b = analyzeRecognitionBaseline([
      scored({ decision: { action: "not-found" }, candidateStatus: "no_candidates" }),
      scored({ decision: { action: "not-found" }, candidateStatus: "provider_unavailable" }),
    ]);
    assert.equal(b.failureModes.noCardExists, 1);
    assert.equal(b.failureModes.providerUnavailable, 1);
  });

  test("failure records: ocr failed vs no card in frame", () => {
    const b = analyzeRecognitionBaseline([
      { v: 1, failureStage: "ocr", extractionStatus: "failed" },
      { v: 1, failureStage: "no-card", extractionStatus: "no_card" },
      { v: 1, failureStage: "database" },
    ]);
    assert.equal(b.failureModes.ocrFailed, 1);
    assert.equal(b.failureModes.noCardInFrame, 1);
    assert.equal(b.failureModes.databaseFailed, 1);
  });

  test("error records route by stage", () => {
    const b = analyzeRecognitionBaseline([
      { v: 1, error: { stage: "database", message: "boom" } },
      { v: 1, error: { stage: "rate-limit", message: "429" } },
      { v: 1, error: { stage: "candidates", message: "?" } },
    ]);
    assert.equal(b.failureModes.databaseFailed, 1);
    assert.equal(b.failureModes.rateLimited, 1);
    assert.equal(b.failureModes.otherError, 1);
  });
});

describe("OCR cost", () => {
  test("median and p95 computed from timings.ocrMs", () => {
    const b = analyzeRecognitionBaseline([
      scored({ timings: { ocrMs: 1000 } }),
      scored({ timings: { ocrMs: 2000 } }),
      scored({ timings: { ocrMs: 3000 } }),
    ]);
    assert.equal(b.ocrCost.n, 3);
    assert.equal(b.ocrCost.medianMs, 2000);
  });
});

// ─── Art-pick agreement (Scanner V2 · M1 step 2) ─────────────────────────────

/** A disambiguation row carrying vision's art pick and (optionally) the label. */
function disambiguated(
  over: { bestMatchExternalId?: string; selectionId?: string } = {},
): Record<string, unknown> {
  const decision: Record<string, unknown> = {
    action: "disambiguate",
    confidence: 0.6,
    margin: 0,
    evidenceMass: 1,
  };
  if (over.bestMatchExternalId !== undefined) decision.bestMatchExternalId = over.bestMatchExternalId;
  const record: Record<string, unknown> = { v: 1, evidence: {}, decision, printingsCount: 3, presentedCount: 3 };
  if (over.selectionId !== undefined) {
    record.selection = { externalId: over.selectionId, game: "MTG", at: "2026-07-19T00:00:00Z" };
  }
  return record;
}

describe("art-pick agreement — was vision's suggestion right?", () => {
  test("counts agreement when vision's pick equals the user's selection", () => {
    const a = analyzeArtPickAgreement([disambiguated({ bestMatchExternalId: "mh2-267", selectionId: "mh2-267" })]);
    assert.equal(a.n, 1);
    assert.equal(a.agree, 1);
    assert.equal(a.disagree, 0);
    assert.equal(a.agreementRate, 1);
    assert.equal(a.disagreementRate, 0);
    assert.equal(a.disambiguationsWithoutPick, 0);
  });

  test("counts disagreement when vision's pick differs from the selection", () => {
    const a = analyzeArtPickAgreement([disambiguated({ bestMatchExternalId: "mh2-267", selectionId: "sld-1234" })]);
    assert.equal(a.n, 1);
    assert.equal(a.agree, 0);
    assert.equal(a.disagree, 1);
    assert.equal(a.agreementRate, 0);
    assert.equal(a.disagreementRate, 1);
    assert.equal(a.disambiguationsWithoutPick, 0);
  });

  test("mixes agree and disagree into a rate over eligible rows only", () => {
    const a = analyzeArtPickAgreement([
      disambiguated({ bestMatchExternalId: "a", selectionId: "a" }),
      disambiguated({ bestMatchExternalId: "b", selectionId: "b" }),
      disambiguated({ bestMatchExternalId: "c", selectionId: "x" }),
    ]);
    assert.equal(a.n, 3);
    assert.equal(a.agree, 2);
    assert.equal(a.disagree, 1);
    assert.equal(a.agreementRate, 2 / 3);
  });

  test("a selection with NO vision pick is disambiguationsWithoutPick, not a disagreement", () => {
    const a = analyzeArtPickAgreement([disambiguated({ selectionId: "mh2-267" })]);
    assert.equal(a.n, 0);
    assert.equal(a.agree, 0);
    assert.equal(a.disagree, 0);
    assert.equal(a.disambiguationsWithoutPick, 1);
  });

  test("a vision pick with NO selection is excluded entirely (no ground truth)", () => {
    const a = analyzeArtPickAgreement([disambiguated({ bestMatchExternalId: "mh2-267" })]);
    assert.equal(a.n, 0);
    assert.equal(a.disambiguationsWithoutPick, 0);
  });

  test("rows missing both fields, and junk, contribute nothing", () => {
    const a = analyzeArtPickAgreement([
      disambiguated(),
      scored(), // an accept: has decision but no selection
      null,
      42,
      { decision: null },
    ]);
    assert.equal(a.n, 0);
    assert.equal(a.agree, 0);
    assert.equal(a.disagree, 0);
    assert.equal(a.disambiguationsWithoutPick, 0);
  });

  test("n=0 reports null rates, never a fabricated number", () => {
    const a = analyzeArtPickAgreement([]);
    assert.equal(a.n, 0);
    assert.equal(a.agreementRate, null);
    assert.equal(a.disagreementRate, null);
    const out = formatArtPickAgreement(a);
    assert.match(out, /No eligible rows yet/);
    assert.match(out, /NOT the auto-accept rate/);
  });

  test("formatter renders a populated agreement without error", () => {
    const a = analyzeArtPickAgreement([
      disambiguated({ bestMatchExternalId: "a", selectionId: "a" }),
      disambiguated({ bestMatchExternalId: "b", selectionId: "x" }),
      disambiguated({ selectionId: "c" }),
    ]);
    const out = formatArtPickAgreement(a);
    assert.match(out, /Eligible rows/);
    assert.match(out, /Disambig\. w\/o vision pick/);
  });
});

describe("robustness", () => {
  test("tolerates junk records without throwing", () => {
    const b = analyzeRecognitionBaseline([null, undefined, 42, "nonsense", {}, { decision: null }]);
    assert.equal(b.totalRecords, 6);
    assert.ok(typeof formatRecognitionBaseline(b) === "string");
  });

  test("formatter renders without error on a populated baseline", () => {
    const b = analyzeRecognitionBaseline([scored({ memory: memoryBlock() })]);
    const out = formatRecognitionBaseline(b);
    assert.match(out, /SERVE SAFETY/);
    assert.match(out, /Recognition Baseline/);
  });
});
