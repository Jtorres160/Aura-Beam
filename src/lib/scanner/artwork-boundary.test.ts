// Artwork boundary tests — verify that narrow-margin art-group-vision
// with uncertain artwork identity gets demoted to user selection.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/artwork-boundary.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { gateDecision, acceptDecision, MARGIN_FLOOR, type Decision } from "@/lib/scanner/decision";
import { assessArtworkBoundary } from "@/lib/scanner/evidence";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Test Card",
    game: "MTG",
    setName: "Set",
    setCode: null,
    collectorNumber: null,
    rarity: "common",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: null,
    ...over,
  };
}

// ─── MTG + art-group-vision: artwork deterministic, narrow margin → ACCEPT ───

test("MTG + art-group-vision + narrow margin (0.05) → ACCEPT (deterministic art)", async () => {
  const candidates = [
    printing({ externalId: "a", game: "MTG", illustrationId: "art-a" }),
    printing({ externalId: "b", game: "MTG", illustrationId: "art-b" }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("MTG"),
  };

  const gated = gateDecision(decision, false, { margin: 0.05, evidenceMass: 2 });

  assert.equal(gated.action, "accept", "MTG should accept despite narrow margin (has deterministic artwork ID)");
  assert.equal(gated.method, "art-group-vision");
});

// ─── Yu-Gi-Oh + art-group-vision: artwork deterministic, narrow margin → ACCEPT ───

test("YGO + art-group-vision + narrow margin (0.05) → ACCEPT (deterministic art)", async () => {
  const candidates = [
    printing({ externalId: "a", game: "YUGIOH", illustrationId: "img-001" }),
    printing({ externalId: "b", game: "YUGIOH", illustrationId: "img-002" }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("YUGIOH"),
  };

  const gated = gateDecision(decision, false, { margin: 0.05, evidenceMass: 2 });

  assert.equal(gated.action, "accept", "YGO should accept despite narrow margin (has deterministic artwork ID)");
  assert.equal(gated.method, "art-group-vision");
});

// ─── Pokémon + art-group-vision: artwork uncertain, narrow margin → DISAMBIGUATE ───

test("Pokémon + art-group-vision + narrow margin (0.05) → DISAMBIGUATE (uncertain art)", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
  };

  const gated = gateDecision(decision, false, { margin: 0.05, evidenceMass: 2 });

  assert.equal(gated.action, "disambiguate", "Pokémon should demote to user selection with narrow margin");
  assert.equal(gated.reason, "user_required_art_selection", "Should have correct reason code");
});

// ─── Pokémon + art-group-vision: artwork uncertain, WIDE margin → ACCEPT ───

test("Pokémon + art-group-vision + wide margin (0.35) → ACCEPT (margin compensates)", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
  };

  const gated = gateDecision(decision, false, { margin: 0.35, evidenceMass: 2 });

  assert.equal(
    gated.action,
    "accept",
    "Pokémon should accept when margin is wide enough (0.35 > MARGIN_FLOOR 0.2)"
  );
  assert.equal(gated.reason, undefined, "Should not have a demote reason");
});

// ─── Pokémon + set-cn-verified: strong method, narrow margin → ACCEPT (strong evidence wins) ───

test("Pokémon + set-cn-verified + narrow margin → ACCEPT (strong method overrides art uncertainty)", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "set-cn-verified"),
    artworkBoundary: assessArtworkBoundary("POKEMON"),
  };

  const gated = gateDecision(decision, false, { margin: 0.05, evidenceMass: 3 });

  assert.equal(gated.action, "accept", "set-cn-verified (0.97) should auto-accept even with narrow margin");
  assert.equal(gated.method, "set-cn-verified");
});

// ─── Edge case: exactly at MARGIN_FLOOR ───

test("Pokémon + art-group-vision + margin exactly at MARGIN_FLOOR (0.2) → ACCEPT", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
  };

  const gated = gateDecision(decision, false, { margin: MARGIN_FLOOR, evidenceMass: 2 });

  assert.equal(gated.action, "accept", "At MARGIN_FLOOR, should accept (>= check)");
});

// ─── Edge case: just below MARGIN_FLOOR ───

test("Pokémon + art-group-vision + margin below MARGIN_FLOOR (0.19) → DISAMBIGUATE", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
  };

  const gated = gateDecision(decision, false, { margin: 0.19, evidenceMass: 2 });

  assert.equal(gated.action, "disambiguate", "Below MARGIN_FLOOR, should demote");
  assert.equal(gated.reason, "user_required_art_selection");
});

// ─── Non-vision methods: not affected by artwork boundary ───

test("Pokémon + single-printing (not art-group-vision) → ACCEPT regardless of margin", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "single-printing"),
    artworkBoundary: assessArtworkBoundary("POKEMON"),
  };

  const gated = gateDecision(decision, false, { margin: 0.05, evidenceMass: 1 });

  assert.equal(
    gated.action,
    "accept",
    "single-printing (non-vision) should not be gated by artwork boundary"
  );
});

// ─── Disambiguate decisions: pass through unchanged ───

test("Already disambiguated decision → pass through unchanged", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON" }),
    printing({ externalId: "b", game: "POKEMON" }),
  ];

  const decision: Decision = {
    action: "disambiguate",
    confidence: 0,
    candidates,
  };

  const gated = gateDecision(decision, false, { margin: 0, evidenceMass: 0 });

  assert.equal(gated.action, "disambiguate", "Already disambiguated, no change");
});

// ─── Regression: Batch 2 Real Margin Calculation ───

test("Clear winner: A .95, B .50 (margin .45) → ACCEPT", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
    decisionMargin: 0.45,
  };

  const gated = gateDecision(decision, false, { margin: 0.45, evidenceMass: 2 });

  assert.equal(gated.action, "accept", "Clear winner (0.45 margin) should accept even with Pokémon art uncertainty");
});

test("Close race: A .91, B .89 (margin .02) → DISAMBIGUATE for Pokémon art", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
    decisionMargin: 0.02,
  };

  const gated = gateDecision(decision, false, { margin: 0.02, evidenceMass: 2 });

  assert.equal(gated.action, "disambiguate", "Close race (0.02 margin) should demote with Pokémon art uncertainty");
  assert.equal(gated.reason, "user_required_art_selection");
});

test("Single candidate: A .96 (margin 1) → ACCEPT", async () => {
  const candidates = [
    printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "art-group-vision"),
    candidates,
    artworkBoundary: assessArtworkBoundary("POKEMON"),
    decisionMargin: 1.0,
  };

  const gated = gateDecision(decision, false, { margin: 1.0, evidenceMass: 2 });

  assert.equal(gated.action, "accept", "Single candidate (margin 1) should always accept");
});

test("MTG set-cn-verified: A .91, B .90 (margin .01) → ACCEPT (identity evidence wins)", async () => {
  const candidates = [
    printing({ externalId: "a", game: "MTG", illustrationId: "art-a" }),
    printing({ externalId: "b", game: "MTG", illustrationId: "art-b" }),
  ];

  const decision: Decision = {
    ...acceptDecision(candidates[0], "set-cn-verified"),
    candidates,
    artworkBoundary: assessArtworkBoundary("MTG"),
    decisionMargin: 0.01,
  };

  const gated = gateDecision(decision, false, { margin: 0.01, evidenceMass: 3 });

  assert.equal(gated.action, "accept", "set-cn-verified (0.97 method) should accept despite narrow margin");
  assert.equal(gated.method, "set-cn-verified", "Method should remain set-cn-verified");
});
