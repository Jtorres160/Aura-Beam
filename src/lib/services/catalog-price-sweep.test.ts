// ═══════════════════════════════════════════════════════════════════════════
// Catalog price sweep — throughput, rotation, and the truth boundary
// ═══════════════════════════════════════════════════════════════════════════
// The sweep was measured against production on 2026-07-28 and found to refresh
// ~23 cards per run against a 20,479-row catalog — a ~890-day full rotation,
// which is why every stored price still read 2026-07-21 a week after the cron
// shipped. It fetched one card per upstream request when the upstream returns a
// whole set for the same price.
//
// Three properties this file pins down, in the order they matter:
//
//   1. ONE request per SET, not per card. This is the entire throughput fix, and
//      it is the kind of thing a later refactor silently undoes.
//
//   2. Rotation ADVANCES. A card upstream has no price for must not be able to
//      park itself at the head of the queue forever. This is why priceCheckedAt
//      exists separately from priceUpdatedAt, and it is the more subtle bug —
//      the old ordering would re-fetch the same unpriced cards every run while
//      the rest of the catalog was never reached.
//
//   3. A non-answer never becomes a price. A set we could not list writes
//      NOTHING; a card with no upstream price keeps the price it had. Neither
//      may be laundered into a fresh-looking zero.
//
// Run: node --import ./test/register.mjs --test src/lib/services/catalog-price-sweep.test.ts

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  refreshCatalogPrices,
  setIdFromExternalId,
  type CatalogRefreshDb,
} from "@/lib/services/catalog-refresh";

// ─── Fake catalog ───────────────────────────────────────────────────────────

interface Row {
  externalId: string;
  marketPrice: number | null;
  priceUpdatedAt: Date | null;
  priceCheckedAt: Date | null;
}

/** A catalog of `sets` sets × `perSet` cards, all checked at the same old time. */
function makeRows(sets: string[], perSet: number, checkedAt: Date | null): Row[] {
  return sets.flatMap((setId) =>
    Array.from({ length: perSet }, (_, i) => ({
      externalId: `${setId}-${i + 1}`,
      marketPrice: 1,
      priceUpdatedAt: checkedAt,
      priceCheckedAt: checkedAt,
    })),
  );
}

function fakeDb(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.externalId, r]));
  const calls = { findMany: 0, transactions: 0, updateMany: 0 };

  const db = {
    catalogCard: {
      async findMany(args: any) {
        calls.findMany++;
        const sorted = [...byId.values()].sort((a, b) => {
          const at = a.priceCheckedAt?.getTime() ?? -Infinity; // nulls first
          const bt = b.priceCheckedAt?.getTime() ?? -Infinity;
          return at - bt;
        });
        return sorted.slice(0, args.take);
      },
      // Returns a THUNK rather than performing the write, mirroring how Prisma's
      // update is a lazy promise the $transaction below is what actually runs.
      update(args: any) {
        return () => {
          const row = byId.get(args.where.externalId);
          if (row) Object.assign(row, args.data);
        };
      },
      async updateMany(args: any) {
        calls.updateMany++;
        for (const id of args.where.externalId.in) {
          const row = byId.get(id);
          if (row) Object.assign(row, args.data);
        }
        return { count: args.where.externalId.in.length };
      },
      async upsert() {
        return {};
      },
      async findFirst() {
        return null;
      },
    },
    async $transaction(ops: any[]) {
      calls.transactions++;
      for (const op of ops) op();
      return [];
    },
  } as unknown as CatalogRefreshDb;

  return { db, byId, calls };
}

// ─── Fake upstream ──────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let fetchedUrls: string[] = [];

/** Serve `set.id:X` listings. `prices` decides which cards carry a tcgplayer
 *  price; `failSets` lists sets whose listing call 500s. */
function stubUpstream(opts: {
  perSet: number;
  price?: number | null;
  unpricedIds?: string[];
  failSets?: string[];
}) {
  const { perSet, price = 9.99, unpricedIds = [], failSets = [] } = opts;
  fetchedUrls = [];
  globalThis.fetch = (async (url: string) => {
    fetchedUrls.push(String(url));
    const m = /set\.id%3A(\w+)/.exec(String(url));
    const setId = m?.[1] ?? "";
    if (failSets.includes(setId)) {
      return { ok: false, status: 500, json: async () => ({}) } as any;
    }
    // A set has exactly `perSet` cards on page 1 and nothing after it. Without
    // this, a perSet of exactly pageSize looks like a full page to fetchSetCards
    // and it pages forever.
    const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? 1);
    if (page > 1) return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    const data = Array.from({ length: perSet }, (_, i) => {
      const id = `${setId}-${i + 1}`;
      const priced = price !== null && !unpricedIds.includes(id);
      return {
        id,
        name: `Card ${i + 1}`,
        number: String(i + 1),
        rarity: "Common",
        set: { id: setId, name: setId, printedTotal: perSet, releaseDate: "2020/01/01" },
        images: {},
        ...(priced ? { tcgplayer: { prices: { normal: { market: price } } } } : {}),
      };
    });
    return { ok: true, status: 200, json: async () => ({ data }) } as any;
  }) as any;
}

beforeEach(() => {
  process.env.POKEMON_TCG_API_KEY = "";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FAR = () => Date.now() + 60_000;
const OLD = new Date("2026-07-21T00:00:00.000Z");

// ─── setIdFromExternalId ────────────────────────────────────────────────────

describe("setIdFromExternalId — the prefix the whole sweep is keyed on", () => {
  test("splits at the FIRST hyphen (no Pokémon set id contains one)", () => {
    assert.equal(setIdFromExternalId("sv3-125"), "sv3");
    assert.equal(setIdFromExternalId("base1-23"), "base1");
    assert.equal(setIdFromExternalId("swshp-SWSH001"), "swshp");
  });

  test("a card number containing a hyphen still yields the set", () => {
    assert.equal(setIdFromExternalId("sm35-TG01-2"), "sm35");
  });

  test("a shape that isn't `set-number` yields null, never a guess", () => {
    // Not swept is a correct outcome; swept as the WRONG set is not.
    assert.equal(setIdFromExternalId("nohyphen"), null);
    assert.equal(setIdFromExternalId("-leading"), null);
    assert.equal(setIdFromExternalId("trailing-"), null);
  });
});

// ─── Property 1: one request per set ────────────────────────────────────────

describe("throughput — the upstream is asked once per SET, not once per card", () => {
  test("240 cards across 2 sets cost 2 requests, not 240", async () => {
    const rows = makeRows(["sv3", "base1"], 120, OLD);
    const { db } = fakeDb(rows);
    stubUpstream({ perSet: 120 });

    const r = await refreshCatalogPrices(db, FAR(), false);

    // fetchSetCards stops paging when a page is short of pageSize, so a 120-card
    // set is exactly one call.
    assert.equal(fetchedUrls.length, 2, "one listing request per set");
    assert.equal(r.refreshed, 240, "every card in both sets was repriced");
    assert.equal(r.examined, 2);
    assert.equal(r.total, 2);
    assert.equal(r.status, "complete");
  });

  test("row writes are batched, not one round trip per card", async () => {
    const rows = makeRows(["sv3"], 250, OLD);
    const { db, calls } = fakeDb(rows);
    stubUpstream({ perSet: 250 });

    await refreshCatalogPrices(db, FAR(), false);

    // 250 rows at a 100-row chunk = 3 transactions. The point is that it is a
    // handful, not 250; the exact chunking is free to change.
    assert.ok(calls.transactions <= 5, `expected a few batched writes, got ${calls.transactions}`);
  });
});

// ─── Property 2: the rotation advances ──────────────────────────────────────

describe("rotation — an unpriced card cannot park at the head of the queue", () => {
  test("a card upstream has no price for still gets priceCheckedAt", async () => {
    const rows = makeRows(["sv3"], 3, OLD);
    const { db, byId } = fakeDb(rows);
    stubUpstream({ perSet: 3, unpricedIds: ["sv3-2"] });

    await refreshCatalogPrices(db, FAR(), false);

    const unpriced = byId.get("sv3-2")!;
    assert.ok(
      unpriced.priceCheckedAt! > OLD,
      "we asked about this card, so the rotation key must move",
    );
    assert.equal(
      unpriced.priceUpdatedAt!.getTime(),
      OLD.getTime(),
      "but no price arrived, so the freshness shown to a collector must NOT move",
    );
    assert.equal(unpriced.marketPrice, 1, "and the stored price is untouched");
  });

  test("the next run moves on to sets it has never reached — the starvation test", async () => {
    // 15 sets, every card permanently unpriced upstream, against a per-run set
    // ceiling of 12. Run one sweeps sets 0-11 and finds no prices anywhere.
    //
    // Under the OLD ordering (stalest priceUpdatedAt) not one of those rows would
    // have moved, so run two would re-fetch sets 0-11 again — and sets 12-14
    // would never be reached, on this run or any future one. Ordering by
    // priceCheckedAt is what turns that deadlock into a rotation.
    const setIds = Array.from({ length: 15 }, (_, i) => `set${i}`);
    const rows = makeRows(setIds, 2, OLD);
    const { db } = fakeDb(rows);

    const sweptSets = () => [
      ...new Set(fetchedUrls.map((u) => /set\.id%3A(\w+)/.exec(u)?.[1] ?? "")),
    ];

    stubUpstream({ perSet: 2, price: null });
    await refreshCatalogPrices(db, FAR(), false);
    const firstRun = sweptSets();

    stubUpstream({ perSet: 2, price: null });
    await refreshCatalogPrices(db, FAR(), false);
    const secondRun = sweptSets();

    assert.deepEqual(firstRun, setIds.slice(0, 12), "run one sweeps the first 12 stalest sets");
    assert.deepEqual(
      secondRun.slice(0, 3),
      ["set12", "set13", "set14"],
      "run two must start with the sets never reached, not re-sweep the same unpriced ones",
    );
  });
});

// ─── Property 3: the truth boundary ─────────────────────────────────────────

describe("truth boundary — a non-answer never becomes a price", () => {
  test("a set whose listing fails writes NOTHING, not even priceCheckedAt", async () => {
    const rows = makeRows(["sv3"], 3, OLD);
    const { db, byId } = fakeDb(rows);
    stubUpstream({ perSet: 3, failSets: ["sv3"] });

    const r = await refreshCatalogPrices(db, FAR(), false);

    for (const row of byId.values()) {
      assert.equal(row.marketPrice, 1, "price untouched");
      assert.equal(row.priceCheckedAt!.getTime(), OLD.getTime(),
        "an unreachable set was never checked — marking it checked would skip it in the rotation");
    }
    assert.equal(r.examined, 0, "a set that never answered was not examined");
    assert.equal(r.status, "incomplete_budget", "and the phase must not read as complete");
    assert.deepEqual(r.failedSets?.map((f) => f.setId), ["sv3"],
      "the hole is reported, not folded into a count");
  });

  test("an unpriced card is never written as 0", async () => {
    const rows = makeRows(["sv3"], 2, OLD);
    const { db, byId } = fakeDb(rows);
    stubUpstream({ perSet: 2, price: null });

    const r = await refreshCatalogPrices(db, FAR(), false);

    for (const row of byId.values()) {
      assert.equal(row.marketPrice, 1, "'no price quoted' must never collapse to $0.00");
    }
    assert.equal(r.refreshed, 0);
    assert.equal(r.skipped, 2);
  });

  test("a dry run performs no writes at all", async () => {
    const rows = makeRows(["sv3"], 3, OLD);
    const { db, byId, calls } = fakeDb(rows);
    stubUpstream({ perSet: 3 });

    const r = await refreshCatalogPrices(db, FAR(), true);

    assert.equal(calls.transactions, 0);
    assert.equal(calls.updateMany, 0);
    for (const row of byId.values()) {
      assert.equal(row.priceCheckedAt!.getTime(), OLD.getTime());
    }
    assert.equal(r.refreshed, 3, "but it still reports what it WOULD have done");
  });
});

// ─── Budget ─────────────────────────────────────────────────────────────────

describe("budget — an exhausted clock reads as incomplete, never as a finding", () => {
  test("no time left → nothing swept, status incomplete", async () => {
    const rows = makeRows(["sv3", "base1"], 2, OLD);
    const { db } = fakeDb(rows);
    stubUpstream({ perSet: 2 });

    const r = await refreshCatalogPrices(db, Date.now() - 1, false);

    assert.equal(r.examined, 0);
    assert.equal(r.refreshed, 0);
    assert.equal(r.status, "incomplete_budget");
    assert.ok(r.total > 0, "it knew what it MEANT to sweep — that's what makes 0 readable");
  });

  test("a failed candidate query is 'failed', not an empty sweep", async () => {
    const db = {
      catalogCard: {
        async findMany() { throw new Error("connection reset"); },
        update() { return () => {}; },
        async updateMany() { return {}; },
        async upsert() { return {}; },
        async findFirst() { return null; },
      },
      async $transaction() { return []; },
    } as unknown as CatalogRefreshDb;

    const r = await refreshCatalogPrices(db, FAR(), false);

    assert.equal(r.status, "failed");
    assert.equal(r.total, 0);
    assert.match(r.error ?? "", /connection reset/);
  });
});
