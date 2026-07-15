// Candidate-retrieval topology tests (Phase 5.13).
//
// These do not measure speed — wall-clock assertions are flaky and would fail
// on a slow CI box for reasons that have nothing to do with the code. They pin
// the STRUCTURAL property that makes the pipeline fast, which is the thing that
// actually regresses:
//
//   The set/CN lookup and the all-printings lookup read only OCR output and
//   never each other's results. They must therefore be IN FLIGHT TOGETHER, not
//   chained.
//
// The bug this locks out is silent: chaining them again costs a whole upstream
// round trip on every scan and nothing fails, so only latency would tell us —
// and only after it reached production. Telemetry showed candidatesMs peaking
// at 18098ms against an 8000ms per-request ceiling, which is arithmetically
// impossible without ≥3 sequential calls.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/candidate-concurrency.test.ts

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchAllPrintings } from "@/lib/scanner/candidates";

const realFetch = globalThis.fetch;

/** One upstream request the stub saw, and whether it was still open when the
 *  next one started — the only question these tests ask. */
interface Call {
  url: string;
  startedAt: number;
  endedAt: number;
}

let calls: Call[] = [];

/** Resolve after `ms`, recording the open/close window of the request. */
function stub(latencyMs: number, respond: (url: string) => unknown) {
  globalThis.fetch = (async (input: any) => {
    const url = decodeURIComponent(String(input));
    const call: Call = { url, startedAt: Date.now(), endedAt: 0 };
    calls.push(call);
    await new Promise((r) => setTimeout(r, latencyMs));
    call.endedAt = Date.now();
    const body = respond(url);
    return {
      ok: body !== null,
      status: body === null ? 404 : 200,
      json: async () => body,
    } as any;
  }) as any;
}

/** True when any two calls' [start, end] windows overlap. */
function hadConcurrentCalls(): boolean {
  for (let i = 0; i < calls.length; i++) {
    for (let j = i + 1; j < calls.length; j++) {
      const a = calls[i];
      const b = calls[j];
      if (a.startedAt < b.endedAt && b.startedAt < a.endedAt) return true;
    }
  }
  return false;
}

const pokemonCard = (name: string, number: string) => ({
  id: `sv3-${number}`,
  name,
  number,
  set: { id: "sv3", name: "Obsidian Flames", ptcgoCode: "OBF", printedTotal: 197 },
  images: { small: "s.png", large: "l.png" },
  rarity: "Rare",
  tcgplayer: { prices: { holofoil: { market: 5 } } },
});

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchAllPrintings — independent lookups run together", () => {
  test("the set/number lookup and the name search are in flight concurrently", async () => {
    // The direct hit returns a DIFFERENT name than OCR read, so the name search
    // is genuinely needed — the common case, and the one that used to pay two
    // full round trips back to back.
    stub(60, (url) =>
      url.includes("number:")
        ? { data: [pokemonCard("Pikachu", "6")] }
        : { data: [pokemonCard("Charizard", "6")] },
    );

    const result = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");

    assert.equal(calls.length, 2, "expected both lookups to be issued");
    assert.ok(hadConcurrentCalls(), "the two lookups were chained, not parallel");
    // Topology changed; the answer must not have.
    assert.equal(result.printings.length, 1);
    assert.equal(result.printings[0].name, "Charizard");
  });

  test("a name-verified set/number hit still short-circuits to set-cn-verified", async () => {
    // The speculative name search is started but its result is discarded. The
    // verdict — and crucially the METHOD, which gates auto-save — is unchanged.
    stub(20, () => ({ data: [pokemonCard("Charizard", "6")] }));

    const result = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");

    assert.equal(result.fallbackMethod, "set-cn-verified");
    assert.equal(result.fallbackCard?.name, "Charizard");
  });

  test("no set/CN means no speculative lookup — only the name search is issued", async () => {
    // Nothing to corroborate, so nothing extra is spent.
    stub(20, () => ({ data: [pokemonCard("Charizard", "6")] }));

    await fetchAllPrintings("Charizard", "POKEMON", "", "", "", "", "");

    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes("number:"));
  });

  test("a rejecting name search cannot crash the scan through the floated promise", async () => {
    // The name search is started before we know whether we'll await it. If the
    // direct hit verifies we return without touching it, so an unhandled
    // rejection here would take down the process rather than one scan.
    globalThis.fetch = (async (input: any) => {
      const url = decodeURIComponent(String(input));
      calls.push({ url, startedAt: Date.now(), endedAt: Date.now() });
      if (!url.includes("number:")) throw new Error("upstream exploded");
      return { ok: true, status: 200, json: async () => ({ data: [pokemonCard("Charizard", "6")] }) } as any;
    }) as any;

    const result = await fetchAllPrintings("Charizard", "POKEMON", "OBF", "006", "", "", "");
    assert.equal(result.fallbackMethod, "set-cn-verified");

    // Let any unhandled rejection surface before the test ends.
    await new Promise((r) => setTimeout(r, 20));
  });
});
