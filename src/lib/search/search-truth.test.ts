// Search truth-layer tests (Phase 5.12A).
//
// These lock in the rule the whole phase exists to enforce:
//
//   A provider failure must NEVER become "no cards found". Only a query where
//   every consulted source COMPLETED and returned zero may claim no matches.
//
// Plus the deterministic bugs this phase repaired, each pinned by a test that
// fails against the old behavior:
//
//   • dedup collapsed every card with a null externalId into one row
//   • game spellings ("POKEMON" vs "Pokémon") never compared equal
//   • "Charizard 006/165" parsed as a name and matched nothing
//   • "Blue Eyes White Dragon" missed "Blue-Eyes White Dragon"
//
// Run: node --import ./test/register.mjs --test src/lib/search/search-truth.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyOutcome,
  SOURCE_LABELS,
  type CardSearchResult,
  type SearchSourceStatus,
} from "@/lib/search/types";
import { cardIdentity, dedupeByIdentity, normalizeGame } from "@/lib/search/identity";
import { collectorNumbersMatch, parseSearchQuery } from "@/lib/search/query";
import { rankResults } from "@/lib/search/match";
import type { GameId } from "@/lib/scanner/evidence";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function card(over: Partial<CardSearchResult> & { name: string; game: GameId }): CardSearchResult {
  return {
    id: over.id ?? over.name,
    game: over.game,
    name: over.name,
    set: over.set ?? { name: "Base Set", code: "BS" },
    collectorNumber: over.collectorNumber ?? null,
    rarity: over.rarity ?? "Common",
    artwork: over.artwork ?? { imageUrl: null, thumbnailUrl: null },
    metadata: over.metadata ?? {
      source: "pokemon",
      externalId: null,
      localId: null,
      marketPrice: null,
    },
  };
}

function source(
  id: SearchSourceStatus["source"],
  availability: SearchSourceStatus["availability"],
  resultCount = 0,
): SearchSourceStatus {
  return {
    source: id,
    label: SOURCE_LABELS[id],
    availability,
    resultCount,
    durationMs: 1,
    ...(availability === "failed" ? { reason: "timeout" as const } : {}),
  };
}

// ─── The core rule ──────────────────────────────────────────────────────────

describe("classifyOutcome — a failure is never a zero", () => {
  test("zero cards + a failed source is provider_unavailable, NOT no_matches", () => {
    const outcome = classifyOutcome([], [source("local", "completed"), source("pokemon", "failed")]);

    assert.equal(outcome.status, "provider_unavailable");
    // The exact regression: the old route rendered this as "No cards found".
    assert.notEqual(outcome.status, "no_matches");
    assert.deepEqual(
      outcome.status === "provider_unavailable" ? outcome.unavailable : [],
      [SOURCE_LABELS.pokemon],
    );
  });

  test("zero cards with every source completed IS a real no_matches", () => {
    const outcome = classifyOutcome([], [
      source("local", "completed"),
      source("scryfall", "completed"),
      source("ygoprodeck", "completed"),
    ]);
    assert.equal(outcome.status, "no_matches");
  });

  test("a source excluded by a game filter is unavailable, not a failure", () => {
    // "unavailable" must not make a genuine zero uncertain — the Phase 5.10 rule.
    const outcome = classifyOutcome([], [
      source("local", "completed"),
      source("pokemon", "completed"),
      source("scryfall", "unavailable"),
      source("ygoprodeck", "unavailable"),
    ]);
    assert.equal(outcome.status, "no_matches");
  });

  test("found cards outrank a failed source, and the failure is still reported", () => {
    const outcome = classifyOutcome([card({ name: "Charizard", game: "POKEMON" })], [
      source("local", "completed", 1),
      source("scryfall", "failed"),
    ]);
    assert.equal(outcome.status, "results");
    assert.equal(outcome.sources.find((s) => s.source === "scryfall")?.availability, "failed");
  });

  test("every source failing is never a no_matches claim", () => {
    const outcome = classifyOutcome([], [
      source("local", "failed"),
      source("pokemon", "failed"),
      source("scryfall", "failed"),
    ]);
    assert.equal(outcome.status, "provider_unavailable");
  });
});

// ─── Dedup identity ─────────────────────────────────────────────────────────

describe("cardIdentity — null externalId must not collapse the result set", () => {
  test("two DIFFERENT cards with null externalId stay two cards", () => {
    // The old dedup compared `a.externalId === b.externalId`; null === null, so
    // these became one row and the rest of the results vanished.
    const cards = [
      card({ name: "Charizard", game: "POKEMON", collectorNumber: "4" }),
      card({ name: "Blastoise", game: "POKEMON", collectorNumber: "2" }),
      card({ name: "Venusaur", game: "POKEMON", collectorNumber: "15" }),
    ];
    assert.equal(dedupeByIdentity(cards).length, 3);
  });

  test("the same printing from two sources merges, local kept", () => {
    const local = card({
      name: "Charizard",
      game: "POKEMON",
      metadata: { source: "local", externalId: "base1-4", localId: "cuid1", marketPrice: 10 },
    });
    const remote = card({
      name: "Charizard",
      game: "POKEMON",
      metadata: { source: "pokemon", externalId: "base1-4", localId: null, marketPrice: null },
    });
    const merged = dedupeByIdentity([local, remote]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].metadata.source, "local");
  });

  test("same externalId across different games does not collide", () => {
    const a = card({
      name: "X",
      game: "POKEMON",
      metadata: { source: "pokemon", externalId: "42", localId: null, marketPrice: null },
    });
    const b = card({
      name: "Y",
      game: "YUGIOH",
      metadata: { source: "ygoprodeck", externalId: "42", localId: null, marketPrice: null },
    });
    assert.notEqual(cardIdentity(a), cardIdentity(b));
    assert.equal(dedupeByIdentity([a, b]).length, 2);
  });

  test("identity is never null-valued", () => {
    const id = cardIdentity(card({ name: "Charizard", game: "POKEMON" }));
    assert.ok(id.length > 0);
    assert.ok(!id.includes("null"));
  });
});

// ─── Game normalization ─────────────────────────────────────────────────────

describe("normalizeGame — one source of truth", () => {
  test("every spelling in the codebase lands on the same id", () => {
    for (const spelling of ["POKEMON", "Pokemon", "pokemon", "Pokémon", "PKMN"]) {
      assert.equal(normalizeGame(spelling), "POKEMON", spelling);
    }
    for (const spelling of ["YUGIOH", "Yu-Gi-Oh!", "yugioh", "YGO"]) {
      assert.equal(normalizeGame(spelling), "YUGIOH", spelling);
    }
    for (const spelling of ["MTG", "mtg", "Magic", "Magic: The Gathering"]) {
      assert.equal(normalizeGame(spelling), "MTG", spelling);
    }
  });

  test("an unknown game returns null rather than guessing", () => {
    assert.equal(normalizeGame("Flesh and Blood"), null);
    assert.equal(normalizeGame(""), null);
    assert.equal(normalizeGame(null), null);
  });
});

// ─── Query parsing ──────────────────────────────────────────────────────────

describe("parseSearchQuery — what collectors actually type", () => {
  test('"Charizard 006/165" splits into name + collector number', () => {
    const p = parseSearchQuery("Charizard 006/165");
    assert.equal(p.name, "Charizard");
    assert.equal(p.collectorNumber, "006");
    assert.equal(p.setSize, "165");
  });

  test('"Lightning Bolt #267" reads the hash form', () => {
    const p = parseSearchQuery("Lightning Bolt #267");
    assert.equal(p.name, "Lightning Bolt");
    assert.equal(p.collectorNumber, "267");
  });

  test("a bare trailing number is NOT assumed to be a collector number", () => {
    // Ambiguous — it may be part of the name. Narrowing on a guess would hide
    // the right card; searching broadly cannot.
    const p = parseSearchQuery("Charizard 4");
    assert.equal(p.collectorNumber, null);
    assert.equal(p.name, "Charizard 4");
  });

  test("plain names are untouched", () => {
    const p = parseSearchQuery("Blue-Eyes White Dragon");
    assert.equal(p.name, "Blue-Eyes White Dragon");
    assert.equal(p.collectorNumber, null);
  });

  test("folding is case/punctuation/accent insensitive", () => {
    assert.equal(parseSearchQuery("Blue Eyes White Dragon").foldedName, "blueeyeswhitedragon");
    assert.equal(parseSearchQuery("BLUE-EYES WHITE DRAGON").foldedName, "blueeyeswhitedragon");
    assert.equal(parseSearchQuery("Pokémon").foldedName, "pokemon");
  });
});

describe("collectorNumbersMatch — printed vs stored", () => {
  test("zero padding and set-size suffixes do not matter", () => {
    assert.ok(collectorNumbersMatch("006", "6"));
    assert.ok(collectorNumbersMatch("006", "006/165"));
    assert.ok(collectorNumbersMatch("21a", "021a"));
  });
  test("different numbers do not match", () => {
    assert.ok(!collectorNumbersMatch("006", "007"));
    assert.ok(!collectorNumbersMatch(null, "6"));
  });
});

// ─── Deterministic relevance ────────────────────────────────────────────────

describe("rankResults — provider recalls, we judge", () => {
  test('"Blue Eyes White Dragon" finds the hyphenated card among noise', () => {
    // Exactly the YGOPRODeck case: fname=Blue returns dozens; folding recovers
    // the one exact card and ranks it first.
    const noise = ["Blue-Eyes Toon Dragon", "Blue Dragon Summoner", "Blue-Eyes Ultimate Dragon"];
    const cards = [
      ...noise.map((n) => card({ name: n, game: "YUGIOH" })),
      card({ name: "Blue-Eyes White Dragon", game: "YUGIOH" }),
    ];
    const ranked = rankResults(parseSearchQuery("Blue Eyes White Dragon"), cards);
    assert.equal(ranked[0].name, "Blue-Eyes White Dragon");
  });

  test("irrelevant cards are dropped, not merely demoted", () => {
    const cards = [
      card({ name: "Blue-Eyes White Dragon", game: "YUGIOH" }),
      card({ name: "Dark Magician", game: "YUGIOH" }),
    ];
    const ranked = rankResults(parseSearchQuery("Blue Eyes White Dragon"), cards);
    assert.equal(ranked.length, 1);
  });

  test("case-insensitive: 'charizard ex' finds 'Charizard ex'", () => {
    const ranked = rankResults(
      parseSearchQuery("charizard ex"),
      [card({ name: "Charizard ex", game: "POKEMON" })],
    );
    assert.equal(ranked.length, 1);
  });

  test("a matching collector number promotes that exact printing", () => {
    const cards = [
      card({ name: "Charizard", game: "POKEMON", collectorNumber: "004" }),
      card({ name: "Charizard", game: "POKEMON", collectorNumber: "006" }),
      card({ name: "Charizard", game: "POKEMON", collectorNumber: "011" }),
    ];
    const ranked = rankResults(parseSearchQuery("Charizard 006/165"), cards);
    assert.equal(ranked[0].collectorNumber, "006");
  });

  test("a conflicting collector number is demoted but NOT removed", () => {
    // A source that omits or misspells a number must not let us imply the card
    // does not exist. Same rule as the scanner: absence is not evidence against.
    const cards = [
      card({ name: "Charizard", game: "POKEMON", collectorNumber: "004" }),
      card({ name: "Charizard", game: "POKEMON", collectorNumber: "006" }),
    ];
    const ranked = rankResults(parseSearchQuery("Charizard 006/165"), cards);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].collectorNumber, "006");
  });

  test("cards with no collector number survive a numbered query", () => {
    const cards = [card({ name: "Charizard", game: "POKEMON", collectorNumber: null })];
    assert.equal(rankResults(parseSearchQuery("Charizard 006/165"), cards).length, 1);
  });
});
