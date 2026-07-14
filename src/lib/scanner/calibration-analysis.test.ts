// Evidence Calibration Analysis tests (Phase 5.11).
//
// These lock the MEASUREMENT contract of the analysis layer. They prove the
// aggregation is correct and — critically — that analysis is OBSERVATIONAL: it
// reads the evidence model and never changes EvidenceMass, EVIDENCE_WEIGHTS, or
// any decision. Samples are built from real assessIdentitySignals() output for
// all three games so state AND availability are produced by the real model, not
// hand-forged.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/calibration-analysis.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeCalibration,
  formatCalibrationAnalysis,
  type CalibrationSample,
  type SignalStats,
} from "@/lib/scanner/calibration-analysis";
import {
  assessIdentitySignals,
  calculateEvidenceCoverage,
  calculateEvidenceMass,
  reading,
  EVIDENCE_WEIGHTS,
  type CandidatePrinting,
  type EvidenceSignal,
  type EvidenceSignalType,
  type GameId,
  type ScanEvidence,
} from "@/lib/scanner/evidence";

// ─── Fixture builders (real model output, per game) ──────────────────────────
// Only the fields passed to evidence() were "read"; everything else is genuinely
// unobserved (undefined → unknown). Candidates carry only what each game's source
// can provide — Pokémon has no illustrationId, Yu-Gi-Oh has no collectorNumber —
// so availability is produced by the real assessSourceCapabilities, not forged.

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

function printing(over: Partial<CandidatePrinting> & { externalId: string; game: GameId }): CandidatePrinting {
  return {
    name: "Test Card",
    setName: "Test Set",
    setCode: "TST",
    collectorNumber: "100",
    rarity: "common",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: null,
    ...over,
  };
}

/** Build one sample from real model output. */
function sample(fixture: string, ev: ScanEvidence, candidate: CandidatePrinting): CalibrationSample {
  return { game: candidate.game, fixture, signals: assessIdentitySignals(ev, candidate) };
}

function statsOf(signals: SignalStats[], type: EvidenceSignalType): SignalStats {
  const s = signals.find((x) => x.type === type);
  assert.ok(s, `expected stats for ${type}`);
  return s!;
}

// ─── A representative multi-game corpus ──────────────────────────────────────
// MTG (5/5 sensors), Pokémon (4/5 — artwork unavailable), Yu-Gi-Oh (4/5 — CN
// unavailable). Pokémon "Double Rare" and Yu-Gi-Oh "Ultra Rare" are not in
// normalizeRarity's table → rarity resolves `unknown` with availability `failed`
// (source supports rarity, but this spelling produced no usable reading).

const ART_MTG = "illo-mtg-a";
const ART_YGO = "89631139";

// MTG: clean full read — every sensor present, everything matches.
const mtgClean = sample(
  "MTG clean full read",
  evidence({ name: "Test Card", setCode: "TST", collectorNumber: "100", rarity: "common", illustrationId: ART_MTG }),
  printing({ externalId: "mtg-1", game: "MTG", illustrationId: ART_MTG }),
);

// MTG: same set, wrong collector number — a single deterministic contradiction.
const mtgWrongCn = sample(
  "MTG wrong collector number",
  evidence({ name: "Test Card", setCode: "TST", collectorNumber: "999", rarity: "common", illustrationId: ART_MTG }),
  printing({ externalId: "mtg-2", game: "MTG", illustrationId: ART_MTG }),
);

// Pokémon: name/set/CN read; rarity spelling unmapped (→ unknown/failed); artwork
// structurally unavailable (source provides no illustrationId).
const pkm = sample(
  "Pokémon Charizard ex",
  evidence({ name: "Test Card", setCode: "TST", collectorNumber: "100", rarity: "Double Rare" }),
  printing({ externalId: "pkm-1", game: "POKEMON", rarity: "Double Rare", illustrationId: null }),
);

// Yu-Gi-Oh: name/set/artwork read; rarity spelling unmapped (→ unknown/failed);
// collector number structurally unavailable (the set code embeds it).
const ygo = sample(
  "Yu-Gi-Oh Blue-Eyes",
  evidence({ name: "Test Card", setCode: "TST", rarity: "Ultra Rare", illustrationId: ART_YGO }),
  printing({
    externalId: "ygo-1",
    game: "YUGIOH",
    rarity: "Ultra Rare",
    collectorNumber: null,
    illustrationId: ART_YGO,
  }),
);

const CORPUS: CalibrationSample[] = [mtgClean, mtgWrongCn, pkm, ygo];

// ═══════════════════════════════════════════════════════════════════════════
//  Test 1 — Multiple fixtures aggregate correctly
// ═══════════════════════════════════════════════════════════════════════════

describe("calibration-analysis — aggregation across fixtures", () => {
  test("sampleCount and per-signal totals reflect every sample", () => {
    const a = analyzeCalibration(CORPUS);
    assert.equal(a.sampleCount, 4);

    // Every signal type appears once per sample → total === sampleCount for each.
    for (const s of a.signals) {
      assert.equal(s.total, 4, `${s.type} should be tallied once per sample`);
    }

    // Signals are reported in canonical order.
    assert.deepEqual(
      a.signals.map((s) => s.type),
      ["name", "setCode", "collectorNumber", "rarity", "artwork"],
    );

    // Each type's buckets partition its total: state and availability both sum to total.
    for (const s of a.signals) {
      assert.equal(s.match + s.mismatch + s.unknown, s.total, `${s.type} state buckets partition total`);
      assert.equal(s.supported + s.failed + s.unavailable, s.total, `${s.type} availability buckets partition total`);
    }
  });

  test("an empty corpus yields empty, well-formed analysis", () => {
    const a = analyzeCalibration([]);
    assert.equal(a.sampleCount, 0);
    assert.deepEqual(a.signals, []);
    assert.deepEqual(a.coverage, []);
    assert.deepEqual(a.warnings, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 2 — Signal counts are correct
// ═══════════════════════════════════════════════════════════════════════════

describe("calibration-analysis — signal counts", () => {
  const a = analyzeCalibration(CORPUS);

  test("name matches in all four samples", () => {
    const name = statsOf(a.signals, "name");
    assert.equal(name.match, 4);
    assert.equal(name.mismatch, 0);
    assert.equal(name.unknown, 0);
    assert.equal(name.supported, 4);
  });

  test("collectorNumber: 1 match, 1 mismatch, 2 unknown (Pokémon match, MTG wrong, YGO unavailable)", () => {
    const cn = statsOf(a.signals, "collectorNumber");
    // mtgClean → match, mtgWrongCn → mismatch, pkm → match… wait: pkm reads CN 100 vs candidate 100 → match.
    assert.equal(cn.match, 2, "MTG clean + Pokémon both read CN 100 against candidate CN 100");
    assert.equal(cn.mismatch, 1, "MTG wrong-CN sample contradicts");
    assert.equal(cn.unknown, 1, "Yu-Gi-Oh has no collector number to compare");
    // Availability: the YGO unknown is structural (unavailable), not a failure.
    assert.equal(cn.unavailable, 1, "Yu-Gi-Oh collectorNumber is unavailable");
    assert.equal(cn.failed, 0);
    assert.equal(cn.supported, 3);
  });

  test("rarity: both MTG 'common' scans map (match); Pokémon/YGO spellings are unknown+failed", () => {
    const rarity = statsOf(a.signals, "rarity");
    assert.equal(rarity.match, 2, "both MTG scans read 'common', which is in normalizeRarity's table");
    assert.equal(rarity.mismatch, 0);
    assert.equal(rarity.unknown, 2, "Pokémon 'Double Rare' and Yu-Gi-Oh 'Ultra Rare' are unmapped → unknown");
    assert.equal(rarity.failed, 2, "supported rarity sensor produced no usable reading for those spellings");
    assert.equal(rarity.unavailable, 0, "rarity is a supported capability for all three games");
  });

  test("artwork: matched for MTG+YGO, unavailable for Pokémon", () => {
    const art = statsOf(a.signals, "artwork");
    assert.equal(art.match, 3, "MTG clean, MTG wrong-CN, and Yu-Gi-Oh all match artwork");
    assert.equal(art.unavailable, 1, "Pokémon provides no artwork identity");
    assert.equal(art.failed, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 3 — Coverage statistics are correct
// ═══════════════════════════════════════════════════════════════════════════

describe("calibration-analysis — coverage statistics", () => {
  const a = analyzeCalibration(CORPUS);

  function cov(game: GameId) {
    const c = a.coverage.find((x) => x.game === game);
    assert.ok(c, `expected coverage for ${game}`);
    return c!;
  }

  test("MTG: 2 samples, 5/5 sensors present each → 10 present, 0 failed, 0 unavailable", () => {
    const c = cov("MTG");
    assert.equal(c.samples, 2);
    assert.equal(c.expected, 10, "5 expected/scan × 2 samples");
    assert.equal(c.present, 10, "both MTG scans read all five sensors");
    assert.equal(c.failed, 0);
    assert.equal(c.unavailable, 0);
    // expected reconciles: present + failed === expected.
    assert.equal(c.present + c.failed, c.expected);
  });

  test("Pokémon: 1 sample, artwork unavailable, rarity failed → present 3, failed 1, unavailable 1", () => {
    const c = cov("POKEMON");
    assert.equal(c.samples, 1);
    assert.equal(c.present, 3, "name + setCode + collectorNumber read");
    assert.equal(c.failed, 1, "rarity spelling produced no usable reading");
    assert.equal(c.unavailable, 1, "artwork structurally unavailable");
    assert.equal(c.expected, 4, "present + failed = the 4 sensors the source offers");
  });

  test("Yu-Gi-Oh: 1 sample, collectorNumber unavailable, rarity failed → present 3, failed 1, unavailable 1", () => {
    const c = cov("YUGIOH");
    assert.equal(c.samples, 1);
    assert.equal(c.present, 3, "name + setCode + artwork read");
    assert.equal(c.failed, 1, "rarity spelling produced no usable reading");
    assert.equal(c.unavailable, 1, "collectorNumber structurally unavailable");
    assert.equal(c.expected, 4);
  });

  test("per-game coverage sums equal the runtime's own calculateEvidenceCoverage", () => {
    // The analysis must not invent its own coverage arithmetic. For each game,
    // the summed present/failed/unavailable equal summing calculateEvidenceCoverage
    // over that game's raw samples.
    for (const game of ["MTG", "POKEMON", "YUGIOH"] as const) {
      const raw = CORPUS.filter((s) => s.game === game).map((s) => calculateEvidenceCoverage(s.signals));
      const c = cov(game);
      assert.equal(c.present, raw.reduce((n, r) => n + r.present, 0));
      assert.equal(c.failed, raw.reduce((n, r) => n + r.failed, 0));
      assert.equal(c.unavailable, raw.reduce((n, r) => n + r.unavailable, 0));
      assert.equal(c.expected, raw.reduce((n, r) => n + r.expected, 0));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 4 — unknown, unavailable and failed remain distinguishable
// ═══════════════════════════════════════════════════════════════════════════
// The Phase 5.10 distinction must survive aggregation: two `unknown` signals with
// DIFFERENT availability must land in different buckets and yield different
// observations.

describe("calibration-analysis — unknown/unavailable/failed stay distinct", () => {
  const a = analyzeCalibration(CORPUS);

  test("Yu-Gi-Oh collectorNumber unknown is counted `unavailable`, not `failed`", () => {
    const cn = statsOf(a.signals, "collectorNumber");
    assert.equal(cn.unavailable, 1, "structural gap");
    assert.equal(cn.failed, 0, "not a sensor failure");
  });

  test("rarity unknowns are counted `failed` (supported source, no usable reading)", () => {
    const rarity = statsOf(a.signals, "rarity");
    // Pokémon + Yu-Gi-Oh rarity spellings unmapped → failed, not unavailable.
    assert.equal(rarity.failed, 2, "supported rarity sensor produced no usable reading");
    assert.equal(rarity.unavailable, 0, "rarity is a supported capability for both games");
  });

  test("warnings distinguish an unavailable sensor from a coverage-gap sensor", () => {
    // Structural unavailability → "unavailable for <GAME> source".
    assert.ok(
      a.warnings.some((w) => w === "artwork unavailable for POKEMON source"),
      "artwork must be flagged unavailable for Pokémon",
    );
    assert.ok(
      a.warnings.some((w) => w === "collectorNumber unavailable for YUGIOH source"),
      "collectorNumber must be flagged unavailable for Yu-Gi-Oh",
    );
    // Coverage gap (failed) → "frequently unknown … coverage gap", NOT "unavailable".
    assert.ok(
      a.warnings.some((w) => w.startsWith("rarity frequently unknown")),
      "rarity's normalization gap must read as a coverage gap, not unavailability",
    );
    assert.ok(
      !a.warnings.some((w) => w.includes("rarity unavailable")),
      "rarity is supported — it must never be reported as unavailable",
    );
  });

  test("contradictions are observed for the wrong-CN fixture", () => {
    assert.ok(
      a.warnings.some((w) => w.startsWith("collectorNumber produced 1 contradiction")),
      "the single wrong-CN sample must surface as one collectorNumber contradiction",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 5 — Analysis does not modify EvidenceMass or decision behavior
// ═══════════════════════════════════════════════════════════════════════════
// The guarantee that keeps Phase 5.11 a measurement phase: running the analysis
// must leave the evidence model — weights, per-signal mass, coverage — byte-for-
// byte identical, and never emit tuning language.

describe("calibration-analysis — observational only", () => {
  test("EVIDENCE_WEIGHTS are untouched by running the analysis", () => {
    const before = JSON.stringify(EVIDENCE_WEIGHTS);
    analyzeCalibration(CORPUS);
    assert.equal(JSON.stringify(EVIDENCE_WEIGHTS), before, "weights must be identical after analysis");
  });

  test("EvidenceMass and coverage of every sample are unchanged before vs after", () => {
    const massBefore = CORPUS.map((s) => calculateEvidenceMass(s.signals));
    const covBefore = CORPUS.map((s) => calculateEvidenceCoverage(s.signals));

    analyzeCalibration(CORPUS);

    const massAfter = CORPUS.map((s) => calculateEvidenceMass(s.signals));
    const covAfter = CORPUS.map((s) => calculateEvidenceCoverage(s.signals));
    assert.deepEqual(massAfter, massBefore, "EvidenceMass must not change");
    assert.deepEqual(covAfter, covBefore, "coverage must not change");
  });

  test("the input signal objects are not mutated", () => {
    const snapshot = CORPUS.map((s) => JSON.stringify(s.signals));
    analyzeCalibration(CORPUS);
    CORPUS.forEach((s, i) => {
      assert.equal(JSON.stringify(s.signals), snapshot[i], "analysis must treat signals as read-only");
    });
  });

  test("warnings are observations, never recommendations (no tuning verbs)", () => {
    const a = analyzeCalibration(CORPUS);
    const forbidden = /\b(increase|decrease|raise|lower|tune|adjust|bump|boost|reduce|reweight|set the weight)\b/i;
    for (const w of a.warnings) {
      assert.ok(!forbidden.test(w), `warning must not prescribe a change: "${w}"`);
    }
    // …and the word "weight" itself never appears — weights are out of scope here.
    for (const w of a.warnings) {
      assert.ok(!/weight/i.test(w), `warning must not mention weights: "${w}"`);
    }
  });

  test("formatCalibrationAnalysis renders all four sections without throwing", () => {
    const text = formatCalibrationAnalysis(analyzeCalibration(CORPUS));
    assert.match(text, /Evidence Calibration Analysis/);
    assert.match(text, /Signal frequency & contribution:/);
    assert.match(text, /Coverage by game:/);
    assert.match(text, /Calibration observations:/);
    // A spot-check that real numbers made it in.
    assert.match(text, /Samples analyzed: 4/);
  });
});
