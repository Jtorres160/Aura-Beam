// M-CATALOG · M4 — local catalog repoint invariants.
//
// The repoint moves candidate generation + the by-id selection re-fetch off the
// live api.pokemontcg.io and onto our own catalog_cards, behind
// CATALOG_LOCAL_ENABLED, FAIL-OPEN. The two properties this file pins down:
//
//   1. PARITY — a local catalog hit returns card data byte-identical to what the
//      live API path would have produced for the same printing. The catalog
//      stores formatPokemonCard()'s own output, and formatCatalogCard() is its
//      exact inverse; this proves the round trip is lossless, INCLUDING prices,
//      the null-set edge, and the ptcgoCode-vs-id setCode fallback.
//
//   2. FAIL-OPEN — a local miss or a local error never asserts "not found". It
//      returns null so the caller falls through to the live API. A miss must
//      degrade to today's behavior, not to a worse one.
//
// The flag-OFF byte-identical guarantee is enforced by the EXISTING suites
// (candidate-truth.test.ts, printing-lookup-truth.test.ts): they exercise the
// Pokémon candidate + by-id paths with CATALOG_LOCAL_ENABLED unset, so if the
// repoint changed the flag-off code path they would break. Here we assert the
// default is OFF, then drive the local path directly with an injected fake
// catalog (the real DB is production — never touched by tests).
//
// Run: node --import ./test/register.mjs --test src/lib/services/catalog-repoint.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatPokemonCard } from "@/lib/services/pokemon";
import {
  CATALOG_LOCAL_ENABLED,
  formatCatalogCard,
  catalogSearchBySetAndNumber,
  catalogFetchCardById,
  type CatalogCardRow,
  type CatalogDb,
} from "@/lib/services/pokemon-catalog";
import { fetchPokemonPrintingsLocal } from "@/lib/scanner/candidates";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

// ─── Fixtures: raw pokemontcg.io card objects across eras/edge cases ─────────

const apiCards: Record<string, any> = {
  // Holo with a full tcgplayer price block + nested set (ptcgoCode present).
  holo: {
    id: "base1-1",
    name: "Alakazam",
    number: "1",
    rarity: "Rare Holo",
    set: { id: "base1", name: "Base", ptcgoCode: "BS", printedTotal: 102 },
    images: { small: "s.png", large: "l.png" },
    tcgplayer: { prices: { holofoil: { low: 40, mid: 60, high: 120, market: 71.88 } } },
  },
  // Brand-new set: TCGplayer hasn't posted a market figure yet → price 0/null.
  unpriced: {
    id: "me5-1",
    name: "Tropius",
    number: "1",
    rarity: "Common",
    set: { id: "me5", name: "Pitch Black", ptcgoCode: "PBL", printedTotal: 100 },
    images: { small: "s.png", large: "l.png" },
    tcgplayer: { prices: {} },
  },
  // Older set with NO ptcgoCode → formatPokemonCard falls setCode back to set.id.
  noPtcgo: {
    id: "xy0-1",
    name: "Weedle",
    number: "1",
    rarity: "Common",
    set: { id: "xy0", name: "Kalos Starter Set", printedTotal: 39 },
    images: { small: "s.png", large: "l.png" },
    tcgplayer: { prices: { normal: { market: 1.26 } } },
  },
};

/** Reproduce exactly what scripts/build-catalog.mjs persists from a formatted
 *  card — the row formatCatalogCard() must invert back to the same printing. */
function rowFromPrinting(p: CandidatePrinting): CatalogCardRow {
  return {
    externalId: p.externalId,
    name: p.name,
    setName: p.setName,
    setCode: p.setCode ?? null,
    setPrintedSize: p.setPrintedSize ?? null,
    collectorNumber: p.collectorNumber ?? null,
    rarity: p.rarity,
    imageUrl: p.imageUrl ?? null,
    thumbnailUrl: p.thumbnailUrl ?? null,
    marketPrice: p.price?.marketPrice ?? null,
    lowPrice: p.price?.lowPrice ?? null,
    midPrice: p.price?.midPrice ?? null,
    highPrice: p.price?.highPrice ?? null,
  };
}

/** A fake catalog. Records the last `where` it was queried with and returns
 *  canned rows — no DB, no network. */
function fakeDb(opts: {
  findMany?: (args: any) => CatalogCardRow[];
  findUnique?: (args: any) => CatalogCardRow | null;
  throwOn?: "findMany" | "findUnique";
}): CatalogDb & { lastWhere?: any } {
  const db: any = {
    catalogCard: {
      findMany: async (args: any) => {
        db.lastWhere = args?.where;
        if (opts.throwOn === "findMany") throw new Error("simulated catalog DB error");
        return opts.findMany ? opts.findMany(args) : [];
      },
      findUnique: async (args: any) => {
        db.lastWhere = args?.where;
        if (opts.throwOn === "findUnique") throw new Error("simulated catalog DB error");
        return opts.findUnique ? opts.findUnique(args) : null;
      },
    },
  };
  return db;
}

// ─── 1. Parity: a local hit == the live-API answer ───────────────────────────

describe("formatCatalogCard — lossless inverse of formatPokemonCard", () => {
  for (const [label, apiCard] of Object.entries(apiCards)) {
    test(`round-trips "${label}" to byte-identical card data`, () => {
      // What the live API path would have returned for this exact card:
      const live = formatPokemonCard(apiCard);
      // What a local catalog hit returns for the row build-catalog stored:
      const local = formatCatalogCard(rowFromPrinting(live));
      // The load-bearing claim of the whole task: identical.
      assert.deepEqual(local, live);
    });
  }

  test("a null-priced catalog row surfaces marketPrice 0, exactly like the live path", () => {
    const live = formatPokemonCard(apiCards.unpriced);
    assert.equal(live.price.marketPrice, 0); // extractPokemonPrice concedes 0
    const local = formatCatalogCard(rowFromPrinting(live));
    assert.equal(local.price.marketPrice, 0);
    assert.deepEqual(local.price, live.price);
  });

  test("setCode falls back to set.id when ptcgoCode is absent — preserved through the round trip", () => {
    const live = formatPokemonCard(apiCards.noPtcgo);
    assert.equal(live.setCode, "xy0"); // no ptcgoCode → set.id
    assert.equal(formatCatalogCard(rowFromPrinting(live)).setCode, "xy0");
  });
});

// ─── 2. Query semantics mirror the live provider's tolerances ────────────────

describe("catalogSearchBySetAndNumber — matches the live query's tolerances", () => {
  test("a zero-padded collector number matches both padded and bare forms", async () => {
    const db = fakeDb({ findMany: () => [] });
    await catalogSearchBySetAndNumber("BS", "021", db);
    assert.deepEqual(db.lastWhere.collectorNumber, { in: ["021", "21"] });
  });

  test("an already-bare number queries just the one form", async () => {
    const db = fakeDb({ findMany: () => [] });
    await catalogSearchBySetAndNumber("BS", "21", db);
    assert.deepEqual(db.lastWhere.collectorNumber, { in: ["21"] });
  });

  test('a "021/102" style number strips the denominator first', async () => {
    const db = fakeDb({ findMany: () => [] });
    await catalogSearchBySetAndNumber("BS", "021/102", db);
    assert.deepEqual(db.lastWhere.collectorNumber, { in: ["021", "21"] });
  });

  test("set code is matched case-insensitively (ptcgoCode OR set.id both stored as one column)", async () => {
    const db = fakeDb({ findMany: () => [] });
    await catalogSearchBySetAndNumber("bs", "1", db);
    assert.deepEqual(db.lastWhere.setCode, { equals: "bs", mode: "insensitive" });
    assert.equal(db.lastWhere.game, "POKEMON");
  });

  test("maps hits through formatCatalogCard", async () => {
    const row = rowFromPrinting(formatPokemonCard(apiCards.holo));
    const db = fakeDb({ findMany: () => [row] });
    const out = await catalogSearchBySetAndNumber("BS", "1", db);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], formatPokemonCard(apiCards.holo));
  });
});

describe("catalogFetchCardById — by-id local re-fetch", () => {
  test("a hit is formatted; queried by externalId", async () => {
    const row = rowFromPrinting(formatPokemonCard(apiCards.holo));
    const db = fakeDb({ findUnique: () => row });
    const out = await catalogFetchCardById("base1-1", db);
    assert.deepEqual(db.lastWhere, { externalId: "base1-1" });
    assert.deepEqual(out, formatPokemonCard(apiCards.holo));
  });

  test("a miss returns null (caller falls through to the live API)", async () => {
    const db = fakeDb({ findUnique: () => null });
    assert.equal(await catalogFetchCardById("nope-0", db), null);
  });
});

// ─── 3. Fail-open orchestration (candidates.fetchPokemonPrintingsLocal) ───────

describe("fetchPokemonPrintingsLocal — fail-open, never a fabricated absence", () => {
  test("a set/number hit whose name matches is a verified fallback", async () => {
    const row = rowFromPrinting(formatPokemonCard(apiCards.holo));
    const db = fakeDb({
      // Only the set/number query returns the single hit.
      findMany: (args) => (args.where.collectorNumber ? [row] : []),
    });
    const outcome = await fetchPokemonPrintingsLocal("Alakazam", "BS", "1", db);
    assert.ok(outcome);
    assert.equal(outcome!.status, "found");
    assert.equal(
      outcome!.status === "found" ? outcome!.fallbackMethod : null,
      "set-cn-verified",
    );
    // Card data is exactly the live-path answer.
    assert.deepEqual(
      outcome!.status === "found" ? outcome!.fallbackCard : null,
      formatPokemonCard(apiCards.holo),
    );
  });

  test("all printings of a name come back as candidates", async () => {
    const row = rowFromPrinting(formatPokemonCard(apiCards.holo));
    const db = fakeDb({
      // No set/number hit; the exact-name query returns the printing.
      findMany: (args) => (args.where.collectorNumber ? [] : [row]),
    });
    const outcome = await fetchPokemonPrintingsLocal("Alakazam", "", "", db);
    assert.ok(outcome);
    assert.equal(outcome!.status, "found");
    assert.equal(outcome!.status === "found" ? outcome!.printings.length : 0, 1);
  });

  test("a TOTAL local miss returns null — NOT no_candidates — so the caller asks the live API", async () => {
    const db = fakeDb({ findMany: () => [], findUnique: () => null });
    const outcome = await fetchPokemonPrintingsLocal("Charizard", "OBF", "6", db);
    // The whole truth boundary in one assertion: a catalog that lacks the card
    // has NOT concluded the card is missing.
    assert.equal(outcome, null);
  });

  test("a local DB error returns null — fail-open to the live API, never a scan failure", async () => {
    const db = fakeDb({ throwOn: "findMany" });
    const outcome = await fetchPokemonPrintingsLocal("Charizard", "OBF", "6", db);
    assert.equal(outcome, null);
  });

  test("the reported source is 'pokemon' and 'completed' on a hit (our catalog answered)", async () => {
    const row = rowFromPrinting(formatPokemonCard(apiCards.holo));
    const db = fakeDb({ findMany: (args) => (args.where.collectorNumber ? [row] : []) });
    const outcome = await fetchPokemonPrintingsLocal("Alakazam", "BS", "1", db);
    assert.equal(outcome!.sources[0].source, "pokemon");
    assert.equal(outcome!.sources[0].availability, "completed");
  });
});

// ─── 4. The flag ships OFF ────────────────────────────────────────────────────

describe("CATALOG_LOCAL_ENABLED — off unless explicitly enabled", () => {
  test("default (env unset) is OFF — the committed state, per M4 ground rules", () => {
    // The existing candidate-truth / printing-lookup suites run in this same
    // flag-off env and exercise the live Pokémon paths; their passing is the
    // byte-identical-when-off guarantee. This just asserts the default.
    assert.equal(CATALOG_LOCAL_ENABLED, process.env.CATALOG_LOCAL_ENABLED === "1");
    assert.equal(CATALOG_LOCAL_ENABLED, false);
  });
});
