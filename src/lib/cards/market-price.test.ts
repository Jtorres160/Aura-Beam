// Price truth — "unpriced" must never become "$0.00".
//
// This is the regression suite for a bug that survived a display-layer fix
// attempt because the information was already gone before anything rendered:
// all three provider extractors coalesced a missing quote to 0, so a card
// nobody has priced and a card genuinely worth nothing were the same number in
// the database. Two properties are pinned here:
//
//   1. WRITE SIDE — every extractor (Pokémon, Scryfall, YGOPRODeck) passes a
//      missing quote through as null, including the "0.00"-string non-answers
//      the Yu-Gi-Oh and Scryfall APIs actually send.
//
//   2. READ SIDE — displayMarketPrice() applies the disclosed legacy-zero
//      convention: rows written before the fix already collapsed to 0 and
//      cannot be un-collapsed, so a stored 0 reads as "no market data" too.
//
// Run: node --import ./test/register.mjs --test src/lib/cards/market-price.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { displayMarketPrice, formatMarketPrice } from "@/lib/cards/market-price";
import { formatPokemonCard } from "@/lib/services/pokemon";
import { formatScryfallCard } from "@/lib/services/scryfall";
import { formatYugiohCard } from "@/lib/services/yugioh";

describe("displayMarketPrice — the read-side convention", () => {
  test("a real figure passes through untouched", () => {
    assert.equal(displayMarketPrice(13.01), 13.01);
    assert.equal(displayMarketPrice(0.02), 0.02);
  });

  test("null (a post-fix unpriced row) is no market data", () => {
    assert.equal(displayMarketPrice(null), null);
    assert.equal(displayMarketPrice(undefined), null);
  });

  test("0 (a pre-fix collapsed row) is ALSO no market data", () => {
    // Deliberate and disclosed: a true $0.00 does not occur for a real tradeable
    // card, so a stored 0 is overwhelmingly a recorded silence. Rendering it as
    // a valuation is the worse of the two errors.
    assert.equal(displayMarketPrice(0), null);
  });

  test("garbage never renders as a price", () => {
    assert.equal(displayMarketPrice(NaN), null);
    assert.equal(displayMarketPrice(Infinity), null);
    assert.equal(displayMarketPrice(-1), null);
    assert.equal(displayMarketPrice("13.01"), null);
  });

  test("formatMarketPrice returns null — not '$0.00' — when there is nothing to show", () => {
    assert.equal(formatMarketPrice(13.01), "$13.01");
    assert.equal(formatMarketPrice(0), null);
    assert.equal(formatMarketPrice(null), null);
  });
});

describe("provider extractors — a missing quote stays missing", () => {
  test("Pokémon: no tcgplayer and no cardmarket block → null", () => {
    const card = formatPokemonCard({
      id: "sv8-1", name: "Unpriced", set: { name: "Set", ptcgoCode: "SV8" },
    });
    assert.equal(card.price.marketPrice, null);
  });

  test("Pokémon: a real quote is still a number", () => {
    const card = formatPokemonCard({
      id: "sv8-2", name: "Priced", set: { name: "Set", ptcgoCode: "SV8" },
      tcgplayer: { prices: { holofoil: { market: 13.01 } } },
    });
    assert.equal(card.price.marketPrice, 13.01);
  });

  test("Pokémon: falls back to cardmarket before conceding null", () => {
    const card = formatPokemonCard({
      id: "sv8-3", name: "CM only", set: { name: "Set", ptcgoCode: "SV8" },
      cardmarket: { prices: { trendPrice: 4.5 } },
    });
    assert.equal(card.price.marketPrice, 4.5);
  });

  test("Scryfall: an absent usd price → null, not 0", () => {
    const card = formatScryfallCard({
      id: "abc", name: "Unpriced", set_name: "Set", prices: {},
    });
    assert.equal(card.price.marketPrice, null);
  });

  test("Scryfall: foil-only printings quote the foil price", () => {
    const card = formatScryfallCard({
      id: "abc", name: "Foil only", set_name: "Set",
      prices: { usd: null, usd_foil: "42.00" },
    });
    assert.equal(card.price.marketPrice, 42);
  });

  test("Yu-Gi-Oh: the API's literal '0.00' non-answer → null", () => {
    // YGOPRODeck sends "0.00" for cards it has no TCGplayer data for. A bare
    // parseFloat turned that string into a $0.00 valuation.
    const card = formatYugiohCard({
      id: 123, name: "Unpriced", card_prices: [{ tcgplayer_price: "0.00" }],
    });
    assert.equal(card.price.marketPrice, null);
  });

  test("Yu-Gi-Oh: a real quote is still a number", () => {
    const card = formatYugiohCard({
      id: 123, name: "Priced", card_prices: [{ tcgplayer_price: "7.25" }],
    });
    assert.equal(card.price.marketPrice, 7.25);
  });
});
