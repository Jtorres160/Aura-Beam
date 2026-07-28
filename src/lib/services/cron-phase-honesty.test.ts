// Phase honesty + budget allocation tests (M5 budget bug — bug B).
//
// The rule this file locks in, stated once:
//
//   A phase's FINDINGS are only meaningful alongside its STATUS. An empty
//   `detected` from a phase that examined 3 of 174 sets is not the same claim as
//   an empty `detected` from a phase that examined all 174, and no consumer
//   should ever have to guess which one it got.
//
// The failure that motivated it: the catalog cron's budget was consumed by set
// enumeration, its per-set loop broke on iteration one, and the response said
// `"detected": []` — indistinguishable from a genuinely current catalog. A new
// Pokémon set could have gone undetected indefinitely while the cron reported
// success. That is a non-answer presented as a negative answer.
//
// Run: node --import ./test/register.mjs --test src/lib/services/cron-phase-honesty.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  allocateRunDeadlines,
  phaseStatus,
  outOfTime,
  TOTAL_BUDGET_MS,
} from "@/lib/services/cron-budget";
import { syncNewSets, type CatalogRefreshDb } from "@/lib/services/catalog-refresh";
import { normalizeGame } from "@/lib/services/owned-price-refresh";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** A catalog DB whose per-set probe is slow enough to burn a small budget. */
function fakeDb(opts: { probeDelayMs?: number } = {}): CatalogRefreshDb {
  const { probeDelayMs = 0 } = opts;
  return {
    catalogCard: {
      async findFirst() {
        if (probeDelayMs) await new Promise((r) => setTimeout(r, probeDelayMs));
        // Every set already exists and is current → nothing genuinely needs sync.
        return { sourceUpdatedAt: new Date("2030-01-01") };
      },
      async findMany() { return []; },
      async upsert() { return {}; },
      async update() { return {}; },
    },
  } as unknown as CatalogRefreshDb;
}

const realFetch = globalThis.fetch;
/** Stub the set-list call with `n` sets. */
function stubSets(n: number) {
  const data = Array.from({ length: n }, (_, i) => ({
    id: `set${i}`,
    releaseDate: "2020/01/01",
    updatedAt: "2020-01-01T00:00:00.000Z",
  }));
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ data }) }) as any) as any;
}
function stubSetsFailing() {
  globalThis.fetch = (async () =>
    ({ ok: false, status: 500, json: async () => ({}) }) as any) as any;
}

// ─── phaseStatus ────────────────────────────────────────────────────────────

describe("phaseStatus — complete requires having examined everything", () => {
  test("examined all → complete", () => {
    assert.equal(phaseStatus(174, 174), "complete");
  });

  test("examined some → incomplete_budget, however healthy the partial looks", () => {
    assert.equal(phaseStatus(3, 174), "incomplete_budget");
  });

  test("nothing to examine is complete, not incomplete", () => {
    // An empty candidate set is a real answer: we looked, there was nothing.
    assert.equal(phaseStatus(0, 0), "complete");
  });
});

// ─── Budget allocation ──────────────────────────────────────────────────────

describe("allocateRunDeadlines — later phases cannot be starved", () => {
  const start = 1_000_000;
  const d = allocateRunDeadlines(start);

  test("phases are ordered and all land inside the total budget", () => {
    assert.ok(d.ownedPrices < d.newSets, "owned prices must yield to new sets");
    assert.ok(d.newSets < d.catalogPrices, "new sets must yield to catalog prices");
    assert.equal(d.catalogPrices, start + TOTAL_BUDGET_MS);
    assert.equal(d.total, start + TOTAL_BUDGET_MS);
  });

  test("every later phase is guaranteed a non-zero window", () => {
    // The M5 bug in one assertion: phase 1 running to ITS deadline must still
    // leave real time for the phases behind it.
    assert.ok(d.newSets - d.ownedPrices > 0, "new-set phase must get a window");
    assert.ok(d.catalogPrices - d.newSets > 0, "catalog price phase must get a window");
  });

  test("the total budget leaves real headroom under the 60s maxDuration", () => {
    assert.ok(TOTAL_BUDGET_MS <= 50_000, "must not crowd the platform ceiling");
  });
});

describe("outOfTime", () => {
  test("true once the deadline has passed", () => {
    assert.equal(outOfTime(Date.now() - 1), true);
  });
  test("false while time remains", () => {
    assert.equal(outOfTime(Date.now() + 5_000), false);
  });
});

// ─── Bug B: the phase must not report an unfinished scan as a finding ───────

describe("syncNewSets — an unfinished scan never reads as 'nothing to sync'", () => {
  test("budget exhausted mid-enumeration → incomplete_budget with examined < total", async () => {
    stubSets(50);
    try {
      // 5ms per probe against a deadline ~40ms out: a handful get examined.
      const db = fakeDb({ probeDelayMs: 5 });
      const r = await syncNewSets(db, Date.now() + 40, true);

      assert.equal(r.status, "incomplete_budget");
      assert.equal(r.total, 50);
      assert.ok(r.examined < 50, `expected a partial scan, examined ${r.examined}`);
      // The findings are still empty — but now they are LABELLED as a prefix.
      assert.deepEqual(r.detected, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a fully examined enumeration IS authoritative", async () => {
    stubSets(3);
    try {
      const r = await syncNewSets(fakeDb(), Date.now() + 10_000, true);
      assert.equal(r.status, "complete");
      assert.equal(r.examined, 3);
      assert.equal(r.total, 3);
      assert.deepEqual(r.detected, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("enumeration that fails outright is 'failed', NOT an empty detected", async () => {
    stubSetsFailing();
    try {
      const r = await syncNewSets(fakeDb(), Date.now() + 10_000, true);
      // The old code returned { error } alongside no status at all, and the
      // caller could still read `detected: []` off it as if it meant something.
      assert.equal(r.status, "failed");
      assert.ok(r.error, "a failed phase must carry why");
      assert.deepEqual(r.detected, [], "no findings…");
      assert.notEqual(r.status, "complete", "…and they must never look authoritative");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a deadline already spent examines nothing and says so", async () => {
    stubSets(10);
    try {
      const r = await syncNewSets(fakeDb(), Date.now() - 1, true);
      assert.equal(r.examined, 0);
      assert.notEqual(r.status, "complete");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ─── The silently-dead Pokémon branch ───────────────────────────────────────

describe("normalizeGame — the comparison that silently skipped every Pokémon card", () => {
  test("matches the value production actually stores", () => {
    // update-prices compared `card.game === "Pokemon"`; prod stores "POKEMON",
    // so all 36 Pokémon cards fell through every branch and the run still
    // reported success.
    assert.equal(normalizeGame("POKEMON"), "POKEMON");
  });

  test("still matches the historical capitalisation", () => {
    assert.equal(normalizeGame("Pokemon"), "POKEMON");
  });

  test("matches the other two games in both casings", () => {
    assert.equal(normalizeGame("MTG"), "MTG");
    assert.equal(normalizeGame("mtg"), "MTG");
    assert.equal(normalizeGame("YUGIOH"), "YUGIOH");
    assert.equal(normalizeGame("Yugioh"), "YUGIOH");
  });

  test("an unrecognised game is null — never guessed into a provider", () => {
    assert.equal(normalizeGame("Lorcana"), null);
    assert.equal(normalizeGame(null), null);
    assert.equal(normalizeGame(undefined), null);
  });
});
