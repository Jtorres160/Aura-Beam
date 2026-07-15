// Scanner by-id lookup truth tests (Phase 5.13C).
//
// The rule this file enforces is the one candidate-truth.test.ts enforces one
// layer up, applied where the collector has already done the hard part:
//
//   A source that did not ANSWER has not told us the card is missing.
//
// Why it matters MORE here than in candidate generation: this lookup runs after
// capture, OCR, vision, candidate generation AND human confirmation. The user
// has looked at the physical card and picked it off a grid Aura drew from this
// very provider's data. Nothing about the card's existence is in question. Yet
// until 5.13C this path answered a provider timeout with:
//
//     404 "Could not verify the selected card. Please scan again."
//
// — the scanner asserting the non-existence of a card it had just displayed,
// and then sending the collector back to the camera to re-derive the same grid
// and hit the same timeout.
//
//     Selection failed ≠ Card does not exist
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/printing-lookup-truth.test.ts

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchPrintingById, fetchPrintingByIdAcrossGames } from "@/lib/scanner/candidates";
import { messageForUnavailableSelection, messageForUnavailableAdd } from "@/lib/scanner/failure";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every request times out — the sensor is dark. */
function stubTimeout() {
  globalThis.fetch = (async () => {
    const e: any = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  }) as any;
}

function stubStatus(status: number, body: any = {}) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as any;
}

// ─── The critical repair ────────────────────────────────────────────────────

describe("fetchPrintingById — a timeout is not a missing card", () => {
  test("Pokemon by-id timeout is provider_unavailable, NOT null/not_found", async () => {
    stubTimeout();
    const result = await fetchPrintingById("POKEMON", "sv3-125");

    // The exact regression: this used to be `null`, which became a 404.
    assert.equal(result.status, "provider_unavailable");
    assert.notEqual(result.status, "not_found");
    assert.equal(result.status === "provider_unavailable" ? result.reason : null, "timeout");
    assert.equal(result.status === "provider_unavailable" ? result.source : null, "pokemon");
  });

  test("MTG by-id timeout is provider_unavailable, and names Scryfall", async () => {
    stubTimeout();
    const result = await fetchPrintingById("MTG", "abc-123");

    assert.equal(result.status, "provider_unavailable");
    assert.equal(result.status === "provider_unavailable" ? result.label : null, "Scryfall (MTG)");
  });

  test("Yu-Gi-Oh by-id timeout is provider_unavailable", async () => {
    stubTimeout();
    const result = await fetchPrintingById("YUGIOH", "46986414");

    assert.equal(result.status, "provider_unavailable");
    assert.equal(result.status === "provider_unavailable" ? result.source : null, "ygoprodeck");
  });

  test("a Scryfall 404 IS an earned not_found — the id really isn't there", async () => {
    // Scryfall answers 404 for an id it has no card for. That is an answer.
    stubStatus(404);
    const result = await fetchPrintingById("MTG", "no-such-id");
    assert.equal(result.status, "not_found");
  });

  test("Pokemon 404 is a FAILURE, not an earned not_found", async () => {
    // Same doctrine as the candidate layer: this API answers 404 both for a
    // genuine miss and when unwell. Safer still on THIS path — the id came from
    // the API itself minutes ago, so a 404 for it is far more likely illness.
    stubStatus(404);
    const result = await fetchPrintingById("POKEMON", "sv3-125");
    assert.equal(result.status, "provider_unavailable");
  });

  test("the two are DISTINGUISHABLE — the whole point of the phase", async () => {
    stubTimeout();
    const timedOut = await fetchPrintingById("MTG", "abc-123");
    stubStatus(404);
    const genuinelyAbsent = await fetchPrintingById("MTG", "abc-123");

    // Before 5.13C both were exactly `null`.
    assert.notEqual(timedOut.status, genuinelyAbsent.status);
    assert.equal(timedOut.status, "provider_unavailable");
    assert.equal(genuinelyAbsent.status, "not_found");
  });

  test("a 500 is unavailable, a rate limit is unavailable, and both say why", async () => {
    stubStatus(500);
    const broke = await fetchPrintingById("MTG", "abc-123");
    assert.equal(broke.status, "provider_unavailable");
    assert.equal(broke.status === "provider_unavailable" ? broke.reason : null, "http_error");

    stubStatus(429);
    const limited = await fetchPrintingById("MTG", "abc-123");
    assert.equal(limited.status === "provider_unavailable" ? limited.reason : null, "rate_limited");
  });

  test("a found card still comes back intact — the happy path is untouched", async () => {
    stubStatus(200, {
      id: "abc-123",
      name: "Lightning Bolt",
      set: "lea",
      set_name: "Limited Edition Alpha",
      collector_number: "161",
      rarity: "common",
      image_uris: { large: "l.png", small: "s.png" },
      prices: { usd: "500.00" },
    });
    const result = await fetchPrintingById("MTG", "abc-123");

    assert.equal(result.status, "found");
    assert.equal(result.status === "found" ? result.card.name : null, "Lightning Bolt");
    assert.equal(result.status === "found" ? result.card.game : null, "MTG");
  });

  test("an unsupported game is not_found — an answered question", async () => {
    // We know we hold no source for it. That is absence of SUPPORT, which we
    // can assert honestly, not absence of an answer.
    stubTimeout();
    const result = await fetchPrintingById("PANINI STICKERS", "x-1");
    assert.equal(result.status, "not_found");
  });
});

// ─── The probe loop (collections/add) ───────────────────────────────────────

describe("fetchPrintingByIdAcrossGames — 'we checked everywhere' needs everywhere to answer", () => {
  test("a quiet source taints the verdict — never a confident 'card not found'", async () => {
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

    const result = await fetchPrintingByIdAcrossGames("some-id");

    // The exact regression: two silent providers, and the old loop still
    // answered 404 "Card not found in local DB or external API".
    assert.equal(result.status, "provider_unavailable");
    assert.notEqual(result.status, "not_found");
    assert.equal(result.status === "provider_unavailable" ? result.source : null, "pokemon");
  });

  test("every source answers and none has it — an EARNED not_found", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      // Each API's own way of saying "I looked; it isn't here".
      if (url.includes("ygoprodeck")) return { ok: false, status: 400, json: async () => ({}) } as any;
      if (url.includes("pokemontcg")) return { ok: true, status: 200, json: async () => ({ data: null }) } as any;
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as any;

    const result = await fetchPrintingByIdAcrossGames("some-id");
    assert.equal(result.status, "not_found");
  });

  test("a card found on a later source outranks an earlier failure", async () => {
    // MTG times out; the card is a real Yu-Gi-Oh card. A dark source must not
    // block a positive identification another source can make.
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("scryfall") || url.includes("pokemontcg")) {
        const e: any = new Error("timeout");
        e.name = "TimeoutError";
        throw e;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: 46986414,
            name: "Dark Magician",
            card_sets: [{ set_name: "LOB", set_code: "LOB-005", set_rarity: "Ultra Rare" }],
            card_images: [{ id: 46986414, image_url: "l.png", image_url_small: "s.png" }],
            card_prices: [{ tcgplayer_price: "12.00" }],
          }],
        }),
      } as any;
    }) as any;

    const result = await fetchPrintingByIdAcrossGames("46986414");
    assert.equal(result.status, "found");
    assert.equal(result.status === "found" ? result.card.name : null, "Dark Magician");
  });
});

// ─── What the collector is told ─────────────────────────────────────────────

describe("selection + add messaging — never blames the card or the user", () => {
  test("selection message names the source and does not claim the card is unreal", () => {
    const msg = messageForUnavailableSelection(["Pokémon TCG API"], "Charizard");

    assert.ok(msg.includes("Pokémon TCG API"), "must name the source that went quiet");
    // The words that would be lies here.
    assert.ok(!/not found/i.test(msg));
    assert.ok(!/no match/i.test(msg));
    assert.ok(!/does not exist|doesn't exist/i.test(msg));
    // "Scan again" is irrational advice: re-running capture/OCR/vision lands on
    // the same grid and the same dark source. The retry that can work is the SAVE.
    assert.ok(!/scan again/i.test(msg), "must not send the user back to the camera");
    assert.ok(/saving again|try again/i.test(msg));
  });

  test("selection message does NOT claim we saved anything — because we didn't", () => {
    // A reassuring "your choice is saved" would be a fresh lie told to paper
    // over an old one. The save is precisely what failed.
    const msg = messageForUnavailableSelection(["Pokémon TCG API"], "Charizard");
    assert.ok(/isn't saved|not saved/i.test(msg), "must be honest that nothing was persisted");
  });

  test("add message says we didn't add it, not that the card is missing", () => {
    const msg = messageForUnavailableAdd(["Scryfall (MTG)"]);

    assert.ok(msg.includes("Scryfall (MTG)"));
    assert.ok(!/not found/i.test(msg));
    assert.ok(!/doesn't exist|does not exist/i.test(msg));
  });

  test("both degrade sanely with no source names", () => {
    for (const msg of [messageForUnavailableSelection([]), messageForUnavailableAdd([])]) {
      assert.ok(msg.length > 0);
      assert.ok(!/not found/i.test(msg));
    }
  });
});
