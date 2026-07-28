// M-CATALOG · M5 — catalog freshness core invariants.
//
// catalog-sync.ts is the enumerate → list → normalize → upsert machinery shared
// by scripts/build-catalog.mjs and /api/cron/refresh-catalog. This file pins the
// properties the unattended cron depends on, all with injected fakes — no live DB,
// no network (the real DB is production; tests never touch it):
//
//   1. FAILURE ISOLATION — one bad card is classified + skipped, never aborts the
//      set; a set that can't be listed throws so the caller records a failed set
//      and moves on. One bad card never nulls a good one.
//   2. RESUME — already-imported cards are skipped when resume is on.
//   3. CHANGE DETECTION — setNeedsSync flags missing/changed sets and ONLY those:
//      an unreadable upstream timestamp is not treated as a change (no churn).
//
// Run: node --import ./test/register.mjs --test src/lib/services/catalog-sync.test.ts

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  syncSet,
  setNeedsSync,
  findSetSyncState,
  classifyFailure,
  parseSetReleaseDate,
  type CatalogSyncDb,
  type CatalogSetMeta,
} from "@/lib/services/catalog-sync";

// ─── A raw pokemontcg.io card object, minimal but formatPokemonCard-complete ──
function apiCard(id: string, extra: Record<string, any> = {}): any {
  return {
    id,
    name: `Card ${id}`,
    number: id.split("-")[1] ?? "1",
    rarity: "Common",
    set: { id: id.split("-")[0], name: "Test Set", ptcgoCode: "TST", printedTotal: 100, updatedAt: "2024/01/01 00:00:00" },
    images: { small: "s.png", large: "l.png" },
    tcgplayer: { prices: { normal: { market: 1.5 } } },
    ...extra,
  };
}

// ─── global fetch stub (restored after each test) ────────────────────────────
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch to answer the set-list call with one page of `cards`, or a status. */
function stubListPage(cards: any[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: cards }), { status: 200 })) as typeof fetch;
}
function stubStatus(status: number) {
  globalThis.fetch = (async () => new Response("upstream sad", { status })) as typeof fetch;
}

/** Fake catalog db. upsert throws for ids in `failUpsertIds`; findMany (resume)
 *  returns `existing` externalIds. */
function fakeDb(opts: { failUpsertIds?: Set<string>; existing?: string[] } = {}): CatalogSyncDb & {
  upserted: string[];
} {
  const upserted: string[] = [];
  return {
    upserted,
    catalogCard: {
      upsert: async (args: any) => {
        const id = args.where.externalId as string;
        if (opts.failUpsertIds?.has(id)) throw new Error("simulated db constraint violation");
        upserted.push(id);
        return {};
      },
      findMany: async () => (opts.existing ?? []).map((externalId) => ({ externalId })),
      findFirst: async () => null,
    },
  };
}

// ─── 0. Deadline (M5 budget bug — bug D) ──────────────────────────────────────
//
// A set can hold ~250 cards and the delay between upserts alone can exceed a
// whole serverless window (3 sets × 250 cards × 250ms ≈ 187s against a 60s
// maxDuration). So the import MUST be able to stop mid-set — and it is only safe
// to do so because the result says it did.

describe("syncSet — the run's clock can stop an import mid-set, honestly", () => {
  test("stops at the deadline and marks the result incomplete", async () => {
    stubListPage([apiCard("sv1-1"), apiCard("sv1-2"), apiCard("sv1-3")]);
    const db = fakeDb();

    // Deadline lands after the list call but before the card loop can finish.
    const r = await syncSet(db, "sv1", {
      delayMs: 8,
      budget: { maxAttempts: 1, deadline: Date.now() + 12 },
    });

    assert.equal(r.incomplete, true, "a truncated import must say so");
    assert.ok(r.upserted < 3, `expected a partial import, got ${r.upserted}`);
  });

  test("a completed import is NOT marked incomplete", async () => {
    stubListPage([apiCard("sv1-1"), apiCard("sv1-2")]);
    const db = fakeDb();

    const r = await syncSet(db, "sv1", {
      delayMs: 0,
      budget: { maxAttempts: 1, deadline: Date.now() + 10_000 },
    });

    assert.equal(r.upserted, 2);
    assert.notEqual(r.incomplete, true);
  });

  test("a resumed run continues rather than restarting", async () => {
    // What makes stopping mid-set safe: the next run skips what already landed,
    // so repeated bounded runs converge on a complete set.
    stubListPage([apiCard("sv1-1"), apiCard("sv1-2"), apiCard("sv1-3")]);
    const db = fakeDb({ existing: ["sv1-1", "sv1-2"] });

    const r = await syncSet(db, "sv1", {
      resume: true,
      delayMs: 0,
      budget: { maxAttempts: 1, deadline: Date.now() + 10_000 },
    });

    assert.equal(r.skipped, 2, "already-imported cards are not re-fetched");
    assert.deepEqual(db.upserted, ["sv1-3"], "only the remainder is imported");
    assert.notEqual(r.incomplete, true);
  });
});

// ─── 1. Failure isolation ─────────────────────────────────────────────────────

describe("syncSet — one bad card never aborts the set", () => {
  test("classifies + skips the failing card, upserts the rest", async () => {
    stubListPage([apiCard("sv1-1"), apiCard("sv1-2"), apiCard("sv1-3")]);
    const db = fakeDb({ failUpsertIds: new Set(["sv1-2"]) });

    const r = await syncSet(db, "sv1", { delayMs: 0, budget: { maxAttempts: 1 } });

    assert.equal(r.upserted, 2);
    assert.equal(r.failed, 1);
    assert.deepEqual(db.upserted, ["sv1-1", "sv1-3"]); // the good ones still landed
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].id, "sv1-2");
    assert.equal(r.failures[0].reason, "db upsert error"); // classified, not raw
  });

  test("a set that can't be listed throws (caller records a failed set)", async () => {
    stubStatus(500); // http_error, not a real zero
    const db = fakeDb();

    await assert.rejects(
      () => syncSet(db, "sv1", { delayMs: 0, budget: { maxAttempts: 1 } }),
      /Upstream responded 500/,
    );
    assert.equal(db.upserted.length, 0);
  });
});

// ─── 2. Resume ────────────────────────────────────────────────────────────────

describe("syncSet — resume skips already-imported cards", () => {
  test("resume:true skips existing externalIds, imports only the new one", async () => {
    stubListPage([apiCard("sv1-1"), apiCard("sv1-2")]);
    const db = fakeDb({ existing: ["sv1-1"] });

    const r = await syncSet(db, "sv1", { resume: true, delayMs: 0, budget: { maxAttempts: 1 } });

    assert.equal(r.skipped, 1);
    assert.equal(r.upserted, 1);
    assert.deepEqual(db.upserted, ["sv1-2"]);
  });

  test("resume:false re-upserts everything (changed-set path)", async () => {
    stubListPage([apiCard("sv1-1"), apiCard("sv1-2")]);
    const db = fakeDb({ existing: ["sv1-1"] });

    const r = await syncSet(db, "sv1", { resume: false, delayMs: 0, budget: { maxAttempts: 1 } });

    assert.equal(r.skipped, 0);
    assert.equal(r.upserted, 2);
  });
});

// ─── 3. Change detection ──────────────────────────────────────────────────────

describe("setNeedsSync — flags missing/changed sets and only those", () => {
  const meta = (updatedAt: string | null): CatalogSetMeta => ({ id: "sv1", releaseDate: "2024-01-01", updatedAt });

  test("missing set → sync", () => {
    assert.equal(setNeedsSync(meta("2024/06/01 00:00:00"), { exists: false, newestSourceUpdatedAt: null }), true);
  });

  test("present + upstream newer than stored → sync", () => {
    const stored = new Date("2024-01-01T00:00:00Z");
    assert.equal(setNeedsSync(meta("2024/06/01 00:00:00"), { exists: true, newestSourceUpdatedAt: stored }), true);
  });

  test("present + upstream older/equal → no sync", () => {
    const stored = new Date("2024-06-01T00:00:00Z");
    assert.equal(setNeedsSync(meta("2024/01/01 00:00:00"), { exists: true, newestSourceUpdatedAt: stored }), false);
  });

  test("present + stored timestamp missing but upstream present → sync (backfill)", () => {
    assert.equal(setNeedsSync(meta("2024/01/01 00:00:00"), { exists: true, newestSourceUpdatedAt: null }), true);
  });

  test("present + no readable upstream timestamp → no sync (never churn on unknown)", () => {
    assert.equal(setNeedsSync(meta(null), { exists: true, newestSourceUpdatedAt: null }), false);
    assert.equal(setNeedsSync(meta("not-a-date"), { exists: true, newestSourceUpdatedAt: new Date() }), false);
  });
});

describe("findSetSyncState — maps a catalog row to existence + newest timestamp", () => {
  test("no row → does not exist", async () => {
    const db: CatalogSyncDb = {
      catalogCard: { upsert: async () => ({}), findMany: async () => [], findFirst: async () => null },
    };
    assert.deepEqual(await findSetSyncState(db, "sv1"), { exists: false, newestSourceUpdatedAt: null });
  });

  test("row present → exists, carries its sourceUpdatedAt", async () => {
    const when = new Date("2024-03-03T00:00:00Z");
    const db: CatalogSyncDb = {
      catalogCard: {
        upsert: async () => ({}),
        findMany: async () => [],
        findFirst: async () => ({ sourceUpdatedAt: when }),
      },
    };
    assert.deepEqual(await findSetSyncState(db, "sv1"), { exists: true, newestSourceUpdatedAt: when });
  });
});

describe("parseSetReleaseDate — recency input for the newest-first cap (M7)", () => {
  test("parses the API's YYYY/MM/DD form", () => {
    assert.equal(parseSetReleaseDate("2025/09/26")?.toISOString().slice(0, 10), "2025-09-26");
  });

  test("orders correctly against another set — the property the cap depends on", () => {
    const mega = parseSetReleaseDate("2025/09/26")!;   // Mega Evolution
    const mcd = parseSetReleaseDate("2016/11/01")!;    // McDonald's Collection 2016
    assert.ok(mega.getTime() > mcd.getTime(), "the newer set must sort ahead of the older one");
  });

  test("returns null for absent/unparseable input rather than inventing a date", () => {
    // A guessed date would silently rank a card it has no business ranking; null
    // sorts last instead. Same truth boundary as sourceUpdatedAt.
    for (const bad of [undefined, null, "", "   ", "not-a-date", 20250926, {}]) {
      assert.equal(parseSetReleaseDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("classifyFailure — coarse, finite buckets", () => {
  test("buckets the reasons the run report shows", () => {
    assert.equal(classifyFailure("No response within 8000ms"), "timeout");
    assert.equal(classifyFailure("prisma constraint failed"), "db upsert error");
    assert.equal(classifyFailure("cannot read properties of undefined"), "normalize error");
    assert.match(classifyFailure("weird upstream string"), /^other:/);
  });
});
