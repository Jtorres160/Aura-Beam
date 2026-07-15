// Search intent & relevance tests (Phase 5.12B).
//
// Phase 5.12A proved a provider failure is never a zero. This phase asks the
// narrower question: given cards we DID receive, which one did the collector
// actually mean? These tests pin the answer.
//
// The rule under test, stated once:
//
//   Corroborating printed evidence outranks a single agreeing signal, and
//   market value is never evidence of identity at all.
//
// Run: node --import ./test/register.mjs --test src/lib/search/search-intent.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { CardSearchResult } from "@/lib/search/types";
import { parseSearchQuery } from "@/lib/search/query";
import { rankResults } from "@/lib/search/match";
import {
  normalizeSearchKey,
  normalizeCollectorNumber,
  setSizesMatch,
} from "@/lib/search/query-normalizer";
import type { GameId } from "@/lib/scanner/evidence";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function card(
  over: Partial<Omit<CardSearchResult, "set">> & {
    name: string;
    game: GameId;
    set?: Partial<CardSearchResult["set"]>;
  },
): CardSearchResult {
  return {
    id: over.id ?? `${over.name}-${over.set?.code ?? "x"}-${over.collectorNumber ?? "x"}`,
    game: over.game,
    name: over.name,
    set: {
      name: over.set?.name ?? "Base Set",
      code: over.set?.code ?? null,
      printedSize: over.set?.printedSize ?? null,
    },
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

// ─── Normalization ──────────────────────────────────────────────────────────

describe("query-normalizer — comparison values only", () => {
  test("punctuation, case and spacing collapse to one key", () => {
    const key = "blueeyeswhitedragon";
    for (const spelling of [
      "Blue-Eyes White Dragon",
      "Blue Eyes White Dragon",
      "BLUE EYES WHITE DRAGON",
      "blue eyes-white dragon",
      "  Blue-Eyes   White  Dragon  ",
    ]) {
      assert.equal(normalizeSearchKey(spelling), key, spelling);
    }
  });

  test("accents fold", () => {
    assert.equal(normalizeSearchKey("Pokémon"), "pokemon");
  });

  test("display names are NEVER mutated — only comparison values", () => {
    // The normalizer is a lens, not a transform. A card still renders with its
    // real hyphens and capitals; only the key we compare on is folded.
    const parsed = parseSearchQuery("Blue-Eyes White Dragon");
    assert.equal(parsed.name, "Blue-Eyes White Dragon");
    assert.equal(parsed.raw, "Blue-Eyes White Dragon");
  });

  test("zero padding is not identity", () => {
    assert.equal(normalizeCollectorNumber("006"), "6");
    assert.equal(normalizeCollectorNumber("006/165"), "6");
    assert.equal(normalizeCollectorNumber("021a"), "21a");
    assert.equal(normalizeCollectorNumber(null), null);
  });

  test("set sizes compare numerically, not textually", () => {
    assert.ok(setSizesMatch("165", "165"));
    assert.ok(setSizesMatch("165", 165));
    assert.ok(!setSizesMatch("165", "198"));
    // Unknown on either side must stand down, never assert a mismatch.
    assert.ok(!setSizesMatch("165", null));
    assert.ok(!setSizesMatch(null, null));
  });
});

// ─── Collector number + set size ────────────────────────────────────────────

describe("parseSearchQuery — the set-size hint is intent, not a filter", () => {
  test('"Charizard 006/165" carries name, number AND set size', () => {
    const p = parseSearchQuery("Charizard 006/165");
    assert.equal(p.name, "Charizard");
    assert.equal(p.collectorNumber, "006");
    assert.equal(p.setSize, "165");
  });
});

describe("rankResults — /165 disambiguates between #006 printings", () => {
  // The exact Phase 5.12B problem: several Charizards are numbered 006. Only
  // one of them is 006 of a 165-card set. The collector told us which.
  const sv151 = card({
    name: "Charizard",
    game: "POKEMON",
    collectorNumber: "006",
    set: { name: "Scarlet & Violet 151", code: "SV151", printedSize: 165 },
  });
  const obsidian = card({
    name: "Charizard",
    game: "POKEMON",
    collectorNumber: "006",
    set: { name: "Obsidian Flames", code: "OBF", printedSize: 197 },
  });
  const unknownSize = card({
    name: "Charizard",
    game: "POKEMON",
    collectorNumber: "006",
    set: { name: "Some Other Set", code: "XYZ", printedSize: null },
  });

  test("the #006 from the 165-card set outranks other #006 cards", () => {
    const ranked = rankResults(parseSearchQuery("Charizard 006/165"), [
      obsidian,
      unknownSize,
      sv151,
    ]);
    assert.equal(ranked[0].set.code, "SV151");
  });

  test("a set-size CONFLICT is demoted but never removed", () => {
    // A source with the wrong printed total must not let us imply the card does
    // not exist. Absence and disagreement are both weaker than a real card.
    const ranked = rankResults(parseSearchQuery("Charizard 006/165"), [obsidian, sv151]);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].set.code, "SV151");
  });

  test("an unknown printed size ranks above a CONFLICTING one", () => {
    // Unavailable evidence is not evidence against — the Phase 5.10 rule. A
    // source that never told us the set size is less damning than one that told
    // us a different number.
    const ranked = rankResults(parseSearchQuery("Charizard 006/165"), [obsidian, unknownSize]);
    assert.equal(ranked[0].set.code, "XYZ");
  });

  test("without a /size hint, the #006 cards stay tied on number evidence", () => {
    const ranked = rankResults(parseSearchQuery("Charizard #006"), [obsidian, sv151]);
    assert.equal(ranked.length, 2);
    ranked.forEach((r) => assert.equal(r.collectorNumber, "006"));
  });
});

// ─── Identity is not value ──────────────────────────────────────────────────

describe("ranking never uses market value", () => {
  test("a $900 wrong-number card loses to a $0 right-number card", () => {
    // Price is a fact ABOUT a card, never evidence of WHICH card. A ranker that
    // learns "expensive means relevant" is a ranker that flatters the collector
    // instead of identifying the card.
    const expensiveWrong = card({
      name: "Charizard",
      game: "POKEMON",
      collectorNumber: "004",
      set: { printedSize: 102 },
      metadata: { source: "pokemon", externalId: "a", localId: null, marketPrice: 900 },
    });
    const cheapRight = card({
      name: "Charizard",
      game: "POKEMON",
      collectorNumber: "006",
      set: { printedSize: 165 },
      metadata: { source: "pokemon", externalId: "b", localId: null, marketPrice: null },
    });
    const ranked = rankResults(parseSearchQuery("Charizard 006/165"), [expensiveWrong, cheapRight]);
    assert.equal(ranked[0].collectorNumber, "006");
  });

  test("reversing every price leaves the evidence order untouched", () => {
    // Cards distinguishable by EVIDENCE (their numbers), with price assigned
    // against that evidence. If price leaked into ranking, reversing the prices
    // would reorder the results. It must not.
    const mk = (collectorNumber: string, printedSize: number, marketPrice: number) =>
      card({
        name: "Charizard",
        game: "POKEMON",
        collectorNumber,
        set: { code: `S${printedSize}`, printedSize },
        metadata: { source: "pokemon", externalId: collectorNumber, localId: null, marketPrice },
      });

    const q = parseSearchQuery("Charizard 006/165");
    // corroborated (006/165), agrees-only (006/198), conflicts (004/102)
    const cheapWins = [mk("004", 102, 900), mk("006", 198, 500), mk("006", 165, 1)];
    const richWins = [mk("004", 102, 1), mk("006", 198, 500), mk("006", 165, 900)];

    const expected = ["S165", "S198", "S102"];
    assert.deepEqual(rankResults(q, cheapWins).map((c) => c.set.code), expected);
    assert.deepEqual(rankResults(q, richWins).map((c) => c.set.code), expected);
  });
});

// ─── Name evidence still leads ──────────────────────────────────────────────

describe("exact name outranks partial name", () => {
  test('"Charizard" prefers the plain card over "Charizard ex"', () => {
    const ranked = rankResults(parseSearchQuery("Charizard"), [
      card({ name: "Charizard ex", game: "POKEMON" }),
      card({ name: "Charizard", game: "POKEMON" }),
    ]);
    assert.equal(ranked[0].name, "Charizard");
  });

  test("punctuation-blind exact match beats a longer prefix match", () => {
    const ranked = rankResults(parseSearchQuery("Blue Eyes White Dragon"), [
      card({ name: "Blue-Eyes White Dragon of Ritual", game: "YUGIOH" }),
      card({ name: "Blue-Eyes White Dragon", game: "YUGIOH" }),
    ]);
    assert.equal(ranked[0].name, "Blue-Eyes White Dragon");
  });
});
