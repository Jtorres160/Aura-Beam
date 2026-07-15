// Scanner candidate truth-layer tests (Phase 5.13B).
//
// The rule this file exists to enforce, stated once:
//
//   A card database that did not ANSWER has not told us the card is missing.
//   Only a database that answered may license "not found".
//
// This is the same rule Phase 5.12A enforced in search (search-truth.test.ts),
// applied to the scanner's candidate layer, where it was still being broken:
// a Pokémon timeout produced `{ printings: [], fallbackCard: null }`, which the
// route rendered as "no match was found in any card database" — a card database
// asserting the non-existence of a card it never looked up.
//
// Found by measurement, not review (Phase 5.13): the Pokémon API's real latency
// distribution (median 1785ms, hangs past 25s) straddles our 8000ms per-request
// ceiling, so this fires in production rather than in theory.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/candidate-truth.test.ts

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchAllPrintings,
  classifyCandidateOutcome,
  CANDIDATE_SOURCE_LABELS,
  type CandidateSourceStatus,
} from "@/lib/scanner/candidates";
import { messageForUnavailableSources } from "@/lib/scanner/failure";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const pokemonCard = (name: string, number: string) => ({
  id: `sv3-${number}`,
  name,
  number,
  set: { id: "sv3", name: "Obsidian Flames", ptcgoCode: "OBF", printedTotal: 197 },
  images: { small: "s.png", large: "l.png" },
  rarity: "Rare",
  tcgplayer: { prices: { holofoil: { market: 5 } } },
});

/** Every request times out — the sensor is dark. */
function stubTimeout() {
  globalThis.fetch = (async () => {
    const e: any = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  }) as any;
}

/** Every request answers cleanly with zero cards — a real absence. */
function stubGenuineZero() {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  })) as any;
}

function printing(name: string): CandidatePrinting {
  return {
    externalId: `x-${name}`,
    name,
    game: "POKEMON",
    setName: "Obsidian Flames",
    rarity: "Rare",
    imageUrl: null,
    thumbnailUrl: null,
    price: { marketPrice: 1 },
  };
}

function source(
  id: CandidateSourceStatus["source"],
  availability: CandidateSourceStatus["availability"],
): CandidateSourceStatus {
  return {
    source: id,
    label: CANDIDATE_SOURCE_LABELS[id],
    availability,
    durationMs: 0,
    ...(availability === "failed" ? { reason: "timeout" as const } : {}),
  };
}

// ─── The core rule ──────────────────────────────────────────────────────────

describe("classifyCandidateOutcome — a failure is never a zero", () => {
  test("zero candidates + a failed source is provider_unavailable, NOT no_candidates", () => {
    const outcome = classifyCandidateOutcome([], null, undefined, [source("pokemon", "failed")]);

    assert.equal(outcome.status, "provider_unavailable");
    // The exact regression: this used to render as "no match was found".
    assert.notEqual(outcome.status, "no_candidates");
    assert.deepEqual(
      outcome.status === "provider_unavailable" ? outcome.unavailable : [],
      [CANDIDATE_SOURCE_LABELS.pokemon],
    );
  });

  test("zero candidates with every source completed IS a real no_candidates", () => {
    const outcome = classifyCandidateOutcome([], null, undefined, [source("scryfall", "completed")]);
    assert.equal(outcome.status, "no_candidates");
  });

  test("found printings outrank a failed source, and the failure is still reported", () => {
    // A card in hand is positive evidence; a failure elsewhere cannot erase it.
    const outcome = classifyCandidateOutcome([printing("Charizard")], null, undefined, [
      source("pokemon", "failed"),
    ]);
    assert.equal(outcome.status, "found");
    assert.equal(outcome.sources[0].availability, "failed");
  });

  test("a fallbackCard also counts as found, failure notwithstanding", () => {
    const outcome = classifyCandidateOutcome([], printing("Charizard"), "set-cn-verified", [
      source("pokemon", "failed"),
    ]);
    assert.equal(outcome.status, "found");
    assert.equal(outcome.status === "found" ? outcome.fallbackMethod : undefined, "set-cn-verified");
  });
});

// ─── The bug, end to end ────────────────────────────────────────────────────

describe("fetchAllPrintings — timeout and absence are different answers", () => {
  test("a Pokemon timeout is provider_unavailable, not an empty result", async () => {
    stubTimeout();
    const outcome = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");

    assert.equal(outcome.status, "provider_unavailable");
    assert.deepEqual(
      outcome.status === "provider_unavailable" ? outcome.unavailable : [],
      [CANDIDATE_SOURCE_LABELS.pokemon],
    );
    assert.equal(outcome.sources[0].reason, "timeout");
  });

  test("a Pokemon zero-result answer IS no_candidates", async () => {
    stubGenuineZero();
    const outcome = await fetchAllPrintings("Nonexistent Card", "POKEMON", "", "", "", "", "");

    assert.equal(outcome.status, "no_candidates");
    assert.equal(outcome.sources[0].availability, "completed");
  });

  test("the two are now DISTINGUISHABLE — the whole point of the phase", async () => {
    stubTimeout();
    const timedOut = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");
    stubGenuineZero();
    const genuineZero = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");

    // Before 5.13B both were exactly { printings: [], fallbackCard: null }.
    assert.notEqual(timedOut.status, genuineZero.status);
    assert.equal(timedOut.status, "provider_unavailable");
    assert.equal(genuineZero.status, "no_candidates");
  });

  test("a timeout still never throws — one dark sensor cannot kill a scan", async () => {
    stubTimeout();
    // The pre-5.13B swallow existed for a real reason: a throw here would kill a
    // scan another signal could rescue. The outcome type keeps that property and
    // drops the lie, rather than trading one for the other.
    const outcome = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");
    assert.ok(outcome.status);
    assert.deepEqual(outcome.printings, []);
  });

  test("MTG: a Scryfall 404 is a real zero, a 500 is not", async () => {
    // Scryfall answers 404 for a search that matched nothing — that is an answer.
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    const notThere = await fetchAllPrintings("Nonexistent", "MTG", "", "", "", "", "");
    assert.equal(notThere.status, "no_candidates");

    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    const broke = await fetchAllPrintings("Lightning Bolt", "MTG", "", "", "", "", "");
    assert.equal(broke.status, "provider_unavailable");
    assert.equal(broke.sources[0].reason, "http_error");
  });

  test("Pokemon 404 is classified as a FAILURE, not a zero", async () => {
    // This API answers 404 both for a genuine miss and when it is simply unwell
    // (six consecutive 404s observed on a query that returned 14 cards minutes
    // earlier). A source that cannot distinguish its own zero from its own
    // illness must not be read as authoritative about absence.
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    const outcome = await fetchAllPrintings("Charizard", "POKEMON", "", "", "", "", "");
    assert.equal(outcome.status, "provider_unavailable");
  });

  test("unknown game: one quiet source taints a 'not in any database' verdict", async () => {
    // Scryfall answers (404 = a real zero); Pokemon times out; YGO answers.
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("pokemontcg")) {
        const e: any = new Error("timeout");
        e.name = "TimeoutError";
        throw e;
      }
      if (url.includes("ygoprodeck")) return { ok: false, status: 400, json: async () => ({}) } as any;
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as any;

    const outcome = await fetchAllPrintings("Charizard", "", "", "", "", "", "");
    // "We checked everywhere" is only true if everywhere answered.
    assert.equal(outcome.status, "provider_unavailable");
    assert.deepEqual(
      outcome.status === "provider_unavailable" ? outcome.unavailable : [],
      [CANDIDATE_SOURCE_LABELS.pokemon],
    );
  });

  test("a rate-limited source is unavailable, and says so", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as any;
    const outcome = await fetchAllPrintings("Charizard", "POKEMON", "", "", "", "", "");
    assert.equal(outcome.status, "provider_unavailable");
    assert.equal(outcome.sources[0].reason, "rate_limited");
  });
});

// ─── What the collector is told ─────────────────────────────────────────────

describe("messageForUnavailableSources — never claims absence", () => {
  test("names the source and does not say the card was not found", () => {
    const msg = messageForUnavailableSources([CANDIDATE_SOURCE_LABELS.pokemon], "Charizard");

    assert.ok(msg.includes("Pokémon TCG API"), "must name the source that went quiet");
    assert.ok(msg.includes("Charizard"), "must name what we did read");
    // The words that would be a lie here.
    assert.ok(!/no match/i.test(msg));
    assert.ok(!/not found/i.test(msg));
    assert.ok(!/doesn't exist|does not exist/i.test(msg));
    // Must not blame the collector's photo for an upstream outage.
    assert.ok(/image was fine/i.test(msg));
  });

  test("degrades sanely when no source names are available", () => {
    const msg = messageForUnavailableSources([]);
    assert.ok(msg.length > 0);
    assert.ok(!/not found/i.test(msg));
  });
});
