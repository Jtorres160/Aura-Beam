// ═══════════════════════════════════════════════════════════════════════════
// Pokémon search repoint — local catalog first, fail-open to live
// ═══════════════════════════════════════════════════════════════════════════
// The scan path stopped asking api.pokemontcg.io for candidate generation in
// M-CATALOG · M4. Search never did, and kept paying for it. Measured through the
// real provider on 2026-07-28:
//
//     pokemon    p50 1903ms  p95 7644ms  max 11786ms  (~55% of requests HTTP 500)
//     scryfall   p50   27ms  p95  140ms
//     ygoprodeck p50  290ms  p95  442ms
//
// while 452 of 452 results the live API returned across ten sampled names were
// already sitting in catalog_cards.
//
// This file exists to protect the ONE property that makes serving search from a
// mirror safe, and it is not the latency:
//
//     A local miss is a QUESTION passed to the live API.
//     It is never an ANSWER returned to the collector.
//
// Everything below is a way of asking that same question. If any of these break,
// the repoint has started asserting the non-existence of cards it merely doesn't
// have yet — which is the exact lie the whole truth layer was built to prevent.
//
// Run: node --import ./test/register.mjs --test src/lib/search/pokemon-search-repoint.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  searchPokemonLocalFirst,
  type PokemonSearchDeps,
} from "@/lib/search/providers/registry";
import { SearchProviderError } from "@/lib/search/providers/http";
import { parseSearchQuery } from "@/lib/search/query";
import {
  catalogSearchForQuery,
  CATALOG_SEARCH_TAKE,
  type CatalogDb,
  type CatalogCardRow,
} from "@/lib/services/pokemon-catalog";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import type { CardSearchResult } from "@/lib/search/types";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function printing(externalId: string, name: string): CandidatePrinting {
  return {
    externalId,
    name,
    game: "POKEMON",
    setName: "Obsidian Flames",
    setCode: "OBF",
    setPrintedSize: 197,
    collectorNumber: "125",
    rarity: "Rare",
    imageUrl: null,
    thumbnailUrl: null,
    price: { marketPrice: 4.2 },
  };
}

function liveCard(id: string): CardSearchResult {
  return {
    id,
    game: "POKEMON",
    name: "From The Live API",
    set: { name: "Brand New Set", code: null, printedSize: null },
    collectorNumber: null,
    rarity: "Rare",
    artwork: { imageUrl: null, thumbnailUrl: null },
    metadata: { source: "pokemon", externalId: id, localId: null, marketPrice: null },
  };
}

/** Deps with everything stubbed and every call counted. */
function deps(over: Partial<PokemonSearchDeps> = {}) {
  const calls = { catalog: 0, live: 0 };
  const base: PokemonSearchDeps = {
    enabled: true,
    catalogSearch: async () => {
      calls.catalog++;
      return [];
    },
    live: async () => {
      calls.live++;
      return [];
    },
  };
  // Count calls even when a case overrides the implementation.
  const merged: PokemonSearchDeps = { ...base, ...over };
  return {
    calls,
    deps: {
      ...merged,
      catalogSearch: (async (...args: Parameters<typeof catalogSearchForQuery>) => {
        calls.catalog++;
        return (over.catalogSearch ?? (async () => []))(...args);
      }) as PokemonSearchDeps["catalogSearch"],
      live: (async (parsed: any) => {
        calls.live++;
        return (over.live ?? (async () => []))(parsed);
      }) as PokemonSearchDeps["live"],
    },
  };
}

const Q = (s: string) => parseSearchQuery(s);

// ─── The latency win: a hit must not touch the network ──────────────────────

describe("a catalog hit is served locally and the live API is never asked", () => {
  test("cards from the catalog are returned, live untouched", async () => {
    const { deps: d, calls } = deps({
      catalogSearch: async () => [printing("obf-125", "Charizard ex")],
    });

    const cards = await searchPokemonLocalFirst(Q("Charizard"), d);

    assert.equal(calls.catalog, 1);
    assert.equal(calls.live, 0, "a catalog hit must not cost an upstream request");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, "obf-125");
    assert.equal(cards[0].metadata.source, "pokemon", "the source a collector is shown is unchanged");
  });

  test("price survives the mapping — a mirror that drops prices is not a mirror", async () => {
    const { deps: d } = deps({
      catalogSearch: async () => [printing("obf-125", "Charizard ex")],
    });
    const cards = await searchPokemonLocalFirst(Q("Charizard"), d);
    assert.equal(cards[0].metadata.marketPrice, 4.2);
  });
});

// ─── The safety property: fail-open ─────────────────────────────────────────

describe("fail-open — a local miss is a question, not an answer", () => {
  test("empty catalog → the live API is asked and its cards are returned", async () => {
    // A set released since the last sync lives here. Returning [] would tell a
    // collector holding a real card that it does not exist.
    const { deps: d, calls } = deps({
      catalogSearch: async () => [],
      live: async () => [liveCard("newset-1")],
    });

    const cards = await searchPokemonLocalFirst(Q("Brand New Card"), d);

    assert.equal(calls.catalog, 1);
    assert.equal(calls.live, 1, "a local miss MUST fall through");
    assert.deepEqual(cards.map((c) => c.id), ["newset-1"]);
  });

  test("catalog THROWS → the live API is asked, and the error never surfaces", async () => {
    // A local Postgres hiccup must degrade to today's behaviour, never to a
    // failed pokemon source — that would claim the Pokémon *database* was
    // unreachable while the live API sat there answering.
    const { deps: d, calls } = deps({
      catalogSearch: async () => {
        throw new Error("connection pool exhausted");
      },
      live: async () => [liveCard("live-1")],
    });

    const cards = await searchPokemonLocalFirst(Q("Charizard"), d);

    assert.equal(calls.live, 1);
    assert.deepEqual(cards.map((c) => c.id), ["live-1"]);
  });

  test("flag off → the catalog is never consulted at all", async () => {
    const { deps: d, calls } = deps({
      enabled: false,
      catalogSearch: async () => [printing("obf-125", "Charizard ex")],
      live: async () => [liveCard("live-1")],
    });

    const cards = await searchPokemonLocalFirst(Q("Charizard"), d);

    assert.equal(calls.catalog, 0, "unset flag ⇒ byte-identical to the pre-repoint path");
    assert.equal(calls.live, 1);
    assert.deepEqual(cards.map((c) => c.id), ["live-1"]);
  });
});

// ─── The truth boundary must survive the repoint ────────────────────────────

describe("truth boundary — a live failure after a local miss still FAILS", () => {
  test("a thrown SearchProviderError propagates; it is not softened into []", async () => {
    // This is the regression that would matter most. If the repoint caught this,
    // a Pokémon outage would read as "no cards found" — a source asserting the
    // non-existence of a card it never looked up.
    const { deps: d } = deps({
      catalogSearch: async () => [],
      live: async () => {
        throw new SearchProviderError("timeout", "No response within 8000ms");
      },
    });

    await assert.rejects(
      () => searchPokemonLocalFirst(Q("Charizard"), d),
      (err: unknown) => {
        assert.ok(err instanceof SearchProviderError);
        assert.equal((err as SearchProviderError).reason, "timeout");
        return true;
      },
      "an unreachable upstream must stay a FAILURE, never become an empty result",
    );
  });

  test("a live REAL zero stays a real zero", async () => {
    // The other half of the same rule: the live API answered, and it genuinely
    // has no such card. That zero is earned and must pass through unchanged.
    const { deps: d } = deps({ catalogSearch: async () => [], live: async () => [] });
    const cards = await searchPokemonLocalFirst(Q("Notacard"), d);
    assert.deepEqual(cards, []);
  });

  test("an empty query wakes neither source", async () => {
    const { deps: d, calls } = deps();
    const cards = await searchPokemonLocalFirst(Q("   "), d);
    assert.deepEqual(cards, []);
    assert.equal(calls.catalog, 0);
    assert.equal(calls.live, 0);
  });
});

// ─── The catalog query itself mirrors the live query's shape ────────────────

function fakeCatalog(rows: Partial<CatalogCardRow>[]) {
  let lastArgs: any = null;
  const db = {
    catalogCard: {
      async findMany(args: any) {
        lastArgs = args;
        return rows.map((r) => ({
          externalId: "x-1", name: "Charizard", setName: "Base", setCode: "BS",
          setPrintedSize: 102, collectorNumber: "4", rarity: "Rare",
          imageUrl: null, thumbnailUrl: null,
          marketPrice: null, lowPrice: null, midPrice: null, highPrice: null,
          ...r,
        }));
      },
      async findUnique() { return null; },
    },
  } as unknown as CatalogDb;
  return { db, args: () => lastArgs };
}

describe("catalogSearchForQuery — same shape as the live query it replaces", () => {
  test("a name recalls by CONTAINS, case-insensitively", async () => {
    const { db, args } = fakeCatalog([{}]);
    await catalogSearchForQuery("charizard", null, db);

    assert.deepEqual(args().where.name, { contains: "charizard", mode: "insensitive" });
    assert.equal(args().where.game, "POKEMON");
  });

  test("the cap is WIDER than the live pageSize — locally the cost is the trip, not the rows", async () => {
    // At take=50 the repoint returned only 230 of the 400 cards the live API did
    // across eight sampled names: both cap at 50 but order differently, so they
    // pick different 50s out of a larger pool. At 250 the overlap is 400/400,
    // measured at the same ~356ms. Narrowing this back to 50 to "match" the live
    // provider would silently delete cards.
    const { db, args } = fakeCatalog([{}]);
    await catalogSearchForQuery("Charizard", null, db);

    assert.equal(args().take, CATALOG_SEARCH_TAKE);
    assert.ok(CATALOG_SEARCH_TAKE >= 250, "measured parity floor");
  });

  test("newest-first ordering, because the cap decides what is REACHABLE", async () => {
    // For a name with more than 50 printings, whatever falls past 50 cannot be
    // found at all. M7 learned this the hard way on catalogFetchAllPrintings.
    const { db, args } = fakeCatalog([{}]);
    await catalogSearchForQuery("Pikachu", null, db);

    assert.deepEqual(args().orderBy[0], { setReleaseDate: { sort: "desc", nulls: "last" } });
  });

  test("a number-ONLY query matches both the padded and bare spellings", async () => {
    // Printed "006", stored "6". Asking for only one spelling deletes the card
    // the collector is holding.
    const { db, args } = fakeCatalog([{}]);
    await catalogSearchForQuery("", "006", db);

    assert.deepEqual(args().where.collectorNumber, { in: ["006", "6"] });
    assert.equal(args().where.name, undefined, "no name means no name predicate");
  });

  test("a name WINS over a number, exactly as the live provider decides", async () => {
    // The live provider deliberately does NOT push the number upstream when it
    // has a name: match.ts judges the number with padding tolerance instead.
    const { db, args } = fakeCatalog([{}]);
    await catalogSearchForQuery("Charizard", "006", db);

    assert.ok(args().where.name, "recall on the name");
    assert.equal(args().where.collectorNumber, undefined, "the number must not narrow the query");
  });

  test("no name and no number asks nothing rather than returning 50 arbitrary rows", async () => {
    const { db, args } = fakeCatalog([{}]);
    const rows = await catalogSearchForQuery("", null, db);
    assert.deepEqual(rows, []);
    assert.equal(args(), null, "the database was never queried");
  });

  test("an unpriced catalog row surfaces null, never $0.00", async () => {
    const { db } = fakeCatalog([{ marketPrice: null }]);
    const rows = await catalogSearchForQuery("Charizard", null, db);
    assert.equal(rows[0].price.marketPrice, null);
  });
});
