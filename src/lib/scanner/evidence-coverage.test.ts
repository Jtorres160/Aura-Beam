// Evidence Coverage Model tests (Phase 5.10).
//
// This file locks in the CONTRACT of the availability axis — the layer that
// teaches Aura the difference between two very different kinds of `unknown`:
//
//   "I don't have this sensor"   (availability: unavailable)   — missing info
//   "My sensor should have fired but didn't"  (availability: failed) — bad info
//
// The invariants under test:
//   • Availability NEVER changes EvidenceMass. unknown ≠ mismatch is untouched:
//     both `unavailable` and `failed` still contribute exactly 0.
//   • `unavailable` reflects a game's source capability (Pokémon artwork, Yu-Gi-Oh
//     collector number) — NOT a scan failure — so it must never be a penalty.
//   • `failed` is distinguishable from `unavailable`: a supported sensor that
//     produced no reading is a coverage gap, an unsupported one is not.
//   • Coverage is computable and observational only — it changes no decision.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/evidence-coverage.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assessIdentitySignals,
  assessSourceCapabilities,
  calculateEvidenceMass,
  calculateEvidenceCoverage,
  reading,
  type CandidatePrinting,
  type EvidenceSignal,
  type EvidenceSignalType,
  type GameId,
  type ScanEvidence,
} from "@/lib/scanner/evidence";

// ─── Fixture builders ────────────────────────────────────────────────────────

/** A candidate printing whose game (and thus source capability) is explicit. */
function printing(over: Partial<CandidatePrinting> & { externalId: string; game: GameId }): CandidatePrinting {
  return {
    name: "Charizard ex",
    setName: "Obsidian Flames",
    setCode: "OBF",
    collectorNumber: "125",
    rarity: "rare",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: null,
    ...over,
  };
}

/** OCR/vision readings off ONE scanned card — only the passed fields were read. */
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

function signalOf(signals: EvidenceSignal[], type: EvidenceSignalType): EvidenceSignal {
  const s = signals.find((x) => x.type === type);
  assert.ok(s, `expected a ${type} signal`);
  return s!;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Test 1 — An unavailable sensor stays neutral (no penalty)
// ═══════════════════════════════════════════════════════════════════════════
// Pokémon supplies no artwork identity. Even when vision guesses an illustration
// group, the candidate has none, so artwork is `unknown` — and because the source
// CANNOT provide it, its availability is `unavailable`. That must cost nothing.

describe("coverage — unavailable sensor is neutral", () => {
  const ev = evidence({
    name: "Charizard ex",
    setCode: "OBF",
    collectorNumber: "125",
    illustrationId: "vision-guessed-group", // vision guessed, but source has none
  });
  const pokemon = printing({ externalId: "p", game: "POKEMON", illustrationId: null });

  test("Pokémon artwork is unknown AND unavailable — not a mismatch, not failed", () => {
    const signals = assessIdentitySignals(ev, pokemon);
    const art = signalOf(signals, "artwork");

    assert.equal(art.state, "unknown", "no source illustrationId → unknown, never mismatch");
    assert.equal(art.availability, "unavailable", "Pokémon cannot provide artwork identity");
  });

  test("an unavailable artwork sensor contributes exactly 0 to EvidenceMass", () => {
    const signals = assessIdentitySignals(ev, pokemon);
    const mass = calculateEvidenceMass(signals);
    const massWithoutArtwork = calculateEvidenceMass(signals.filter((s) => s.type !== "artwork"));

    // No penalty: dropping the unavailable sensor entirely changes nothing.
    assert.equal(mass, massWithoutArtwork, "an unavailable sensor must never move EvidenceMass");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 2 — A failed sensor is distinguishable from an unavailable one
// ═══════════════════════════════════════════════════════════════════════════
// MTG DOES provide artwork identity. When a scan produces no illustration read
// (vision didn't run / no group matched) against a real MTG candidate that HAS an
// illustrationId, artwork is `unknown` — but the sensor SHOULD have fired, so its
// availability is `failed`. Same state as Pokémon's artwork, different availability:
// this is the whole point of Phase 5.10.

describe("coverage — failed vs. unavailable are distinguishable", () => {
  const mtgCandidate = printing({
    externalId: "m",
    game: "MTG",
    illustrationId: "illo-real", // MTG source provides artwork identity…
  });
  const pokemonCandidate = printing({ externalId: "p", game: "POKEMON", illustrationId: null });

  // Scan read name+set+CN but produced NO illustration id (the artwork sensor
  // didn't produce a reading this scan).
  const evNoArt = evidence({ name: "Charizard ex", setCode: "OBF", collectorNumber: "125" });

  test("MTG artwork with no reading is `failed` (supported sensor, no result)", () => {
    const art = signalOf(assessIdentitySignals(evNoArt, mtgCandidate), "artwork");
    assert.equal(art.state, "unknown");
    assert.equal(art.availability, "failed", "MTG artwork is supported → an empty reading is a failure");
  });

  test("Pokémon artwork with no reading is `unavailable` (source can't provide it)", () => {
    const art = signalOf(assessIdentitySignals(evNoArt, pokemonCandidate), "artwork");
    assert.equal(art.state, "unknown");
    assert.equal(art.availability, "unavailable", "Pokémon artwork is not a supported sensor");
  });

  test("the two share a state but differ in availability — the Phase 5.10 distinction", () => {
    const mtgArt = signalOf(assessIdentitySignals(evNoArt, mtgCandidate), "artwork");
    const pkmArt = signalOf(assessIdentitySignals(evNoArt, pokemonCandidate), "artwork");

    assert.equal(mtgArt.state, pkmArt.state, "identical state (both unknown)…");
    assert.notEqual(mtgArt.availability, pkmArt.availability, "…but different availability");

    // Neither is penalized — both stay neutral. The distinction is descriptive.
    assert.equal(calculateEvidenceMass([mtgArt]), 0);
    assert.equal(calculateEvidenceMass([pkmArt]), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 3 — Coverage can be calculated (observational only)
// ═══════════════════════════════════════════════════════════════════════════
// The cross-game evidence map, expressed as expected-sensor counts:
//   MTG 5/5, Pokémon 4/5, Yu-Gi-Oh 4/5.
// `expected` counts the sensors a game's source CAN provide, so it is stable even
// when a supported sensor fails to read on a given scan.

describe("coverage — expected-sensor counts per game", () => {
  const TYPES: EvidenceSignalType[] = ["name", "setCode", "collectorNumber", "rarity", "artwork"];

  function expectedCount(game: GameId): number {
    const caps = assessSourceCapabilities(game);
    return TYPES.filter((t) => caps[t]).length;
  }

  test("source capability yields MTG 5/5, Pokémon 4/5, Yu-Gi-Oh 4/5", () => {
    assert.equal(expectedCount("MTG"), 5, "MTG provides every identity sensor");
    assert.equal(expectedCount("POKEMON"), 4, "Pokémon lacks artwork identity");
    assert.equal(expectedCount("YUGIOH"), 4, "Yu-Gi-Oh lacks collector number");
  });

  test("the missing sensor is game-specific and correctly named", () => {
    assert.equal(assessSourceCapabilities("POKEMON").artwork, false, "Pokémon: artwork unavailable");
    assert.equal(assessSourceCapabilities("YUGIOH").collectorNumber, false, "Yu-Gi-Oh: collectorNumber unavailable");
    // And the sensors each game DOES have are present.
    assert.equal(assessSourceCapabilities("POKEMON").collectorNumber, true);
    assert.equal(assessSourceCapabilities("YUGIOH").artwork, true);
  });

  test("a clean full-read scan reports every expected sensor present", () => {
    // MTG: all five read and match → 5 present, 0 failed, 0 unavailable.
    const mtgCov = calculateEvidenceCoverage(
      assessIdentitySignals(
        evidence({ name: "Charizard ex", setCode: "OBF", collectorNumber: "125", rarity: "rare", illustrationId: "illo-a" }),
        printing({ externalId: "m", game: "MTG", illustrationId: "illo-a" }),
      ),
    );
    assert.deepEqual(mtgCov, { expected: 5, present: 5, failed: 0, unavailable: 0, total: 5 });

    // Pokémon: name/set/CN/rarity read; artwork structurally unavailable.
    const pkmCov = calculateEvidenceCoverage(
      assessIdentitySignals(
        evidence({ name: "Charizard ex", setCode: "OBF", collectorNumber: "125", rarity: "rare" }),
        printing({ externalId: "p", game: "POKEMON", illustrationId: null }),
      ),
    );
    assert.deepEqual(pkmCov, { expected: 4, present: 4, failed: 0, unavailable: 1, total: 5 });

    // Yu-Gi-Oh: name/set/rarity/artwork read; collector number unavailable.
    const ygoCov = calculateEvidenceCoverage(
      assessIdentitySignals(
        evidence({ name: "Charizard ex", setCode: "OBF", rarity: "rare", illustrationId: "illo-a" }),
        printing({ externalId: "y", game: "YUGIOH", collectorNumber: null, illustrationId: "illo-a" }),
      ),
    );
    assert.deepEqual(ygoCov, { expected: 4, present: 4, failed: 0, unavailable: 1, total: 5 });
  });

  test("a failed sensor lowers `present` but NOT `expected` (the coverage gap is visible)", () => {
    // MTG scan where the set code was never read: setCode is supported but empty.
    const cov = calculateEvidenceCoverage(
      assessIdentitySignals(
        evidence({ name: "Charizard ex", collectorNumber: "125", rarity: "rare", illustrationId: "illo-a" }),
        printing({ externalId: "m", game: "MTG", illustrationId: "illo-a" }),
      ),
    );
    // expected stays 5 (MTG capability), present drops to 4, one sensor failed.
    assert.deepEqual(cov, { expected: 5, present: 4, failed: 1, unavailable: 0, total: 5 });
  });

  test("`is EvidenceMass limited by unavailable data?` is answerable from coverage", () => {
    // A fully-agreeing Pokémon scan: strong mass, but coverage shows one sensor
    // (artwork) is unavailable — the reason the mass ceiling is lower than MTG's.
    const signals = assessIdentitySignals(
      evidence({ name: "Charizard ex", setCode: "OBF", collectorNumber: "125", rarity: "rare" }),
      printing({ externalId: "p", game: "POKEMON", illustrationId: null }),
    );
    const cov = calculateEvidenceCoverage(signals);
    assert.ok(calculateEvidenceMass(signals) > 0, "deterministic evidence still confirms identity");
    assert.equal(cov.unavailable, 1, "and coverage explains what the score could NOT draw on");
    assert.equal(cov.failed, 0, "nothing failed — the missing sensor is expected for this game");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Test 4 — Availability is descriptive: it never moves EvidenceMass
// ═══════════════════════════════════════════════════════════════════════════
// The guard that keeps Phase 5.10 observational. Whatever a signal's availability,
// its mass contribution is decided by STATE alone (match +w, mismatch −w, unknown
// 0). This is what guarantees existing calibration observations are unchanged.

describe("coverage — availability does not affect EvidenceMass", () => {
  test("unavailable and failed unknowns both contribute exactly 0", () => {
    const evNoArt = evidence({ name: "Charizard ex", setCode: "OBF", collectorNumber: "125" });

    const failedArt = signalOf(
      assessIdentitySignals(evNoArt, printing({ externalId: "m", game: "MTG", illustrationId: "illo-a" })),
      "artwork",
    );
    const unavailableArt = signalOf(
      assessIdentitySignals(evNoArt, printing({ externalId: "p", game: "POKEMON", illustrationId: null })),
      "artwork",
    );

    assert.equal(failedArt.availability, "failed");
    assert.equal(unavailableArt.availability, "unavailable");
    // Different availability, identical (zero) mass contribution.
    assert.equal(calculateEvidenceMass([failedArt]), calculateEvidenceMass([unavailableArt]));
    assert.equal(calculateEvidenceMass([failedArt]), 0);
  });

  test("match/mismatch signals are `supported` regardless of game", () => {
    const ev = evidence({ name: "Charizard ex", setCode: "OBF", collectorNumber: "125" });
    for (const game of ["MTG", "POKEMON", "YUGIOH"] as const) {
      const name = signalOf(assessIdentitySignals(ev, printing({ externalId: "x", game })), "name");
      assert.equal(name.state, "match");
      assert.equal(name.availability, "supported", "a produced reading is always supported");
    }
  });
});
