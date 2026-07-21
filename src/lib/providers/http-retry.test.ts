// Provider transport retry tests (Phase 5.19).
//
// The rule this file locks in, stated once:
//
//   A request that never got a real answer is retried; a request that DID
//   answer — a value, or a clean zero via emptyStatuses — is not. So the retry
//   can only ever turn "we couldn't ask" into "we asked", never a real
//   "not found" into a retry.
//
// The failure that motivated it: the Pokémon TCG API returned HTTP 500 on ~half
// of identical requests during a live demo, with 200s interleaved seconds apart
// on the same URL, so every scan surfaced "couldn't verify". A retry within one
// scan rides that out.
//
// Backoff delays are zeroed by the test harness (test/register.mjs sets
// PROVIDER_RETRY_BASE_MS=0), so these assert the retry COUNT and OUTCOME without
// sleeping.
//
// Run: node --import ./test/register.mjs --test src/lib/providers/http-retry.test.ts

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchProviderJson, ProviderError } from "@/lib/providers/http";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch stub that fails `failFor` attempts, then answers 200 with `body`. */
function failThenSucceed(failFor: number, status: number, body: unknown) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= failFor) {
      return { ok: false, status, json: async () => ({}) } as any;
    }
    return { ok: true, status: 200, json: async () => body } as any;
  }) as any;
  return () => calls;
}

/** A fetch stub that always returns the given status. */
function alwaysStatus(status: number) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as any;
  }) as any;
  return () => calls;
}

describe("fetchProviderJson retry — transient failures are ridden out", () => {
  test("a 500 then a 200 resolves to the 200, transparently", async () => {
    const count = failThenSucceed(1, 500, { data: ["ok"] });
    const json = await fetchProviderJson<{ data: string[] }>("https://x/y");
    assert.deepEqual(json, { data: ["ok"] });
    assert.equal(count(), 2, "should have retried exactly once");
  });

  test("survives four 500s and succeeds on the fifth attempt", async () => {
    const count = failThenSucceed(4, 500, { data: ["ok"] });
    const json = await fetchProviderJson("https://x/y");
    assert.ok(json);
    assert.equal(count(), 5, "five attempts is the ceiling and it used all five");
  });

  test("gives up after the attempt ceiling and throws the classified error", async () => {
    const count = alwaysStatus(500);
    await assert.rejects(
      () => fetchProviderJson("https://x/y"),
      (err: unknown) => err instanceof ProviderError && err.reason === "http_error",
    );
    assert.equal(count(), 5, "should stop at the 5-attempt ceiling");
  });

  test("a rate-limit (429) is retried", async () => {
    const count = failThenSucceed(2, 429, { data: [] });
    const json = await fetchProviderJson("https://x/y");
    assert.deepEqual(json, { data: [] });
    assert.equal(count(), 3);
  });
});

describe("fetchProviderJson retry — real answers are never retried", () => {
  test("a 200 answers on the first attempt, no retry", async () => {
    const count = alwaysStatus(200);
    // alwaysStatus(200) returns ok with empty {} body — a real answer.
    const json = await fetchProviderJson("https://x/y");
    assert.deepEqual(json, {});
    assert.equal(count(), 1, "a healthy request pays nothing");
  });

  test("an emptyStatus (a real zero) returns null without retrying", async () => {
    const count = alwaysStatus(404);
    const json = await fetchProviderJson("https://x/y", { emptyStatuses: [404] });
    assert.equal(json, null);
    assert.equal(count(), 1, "a real zero is an answer, not a failure");
  });

  test("a malformed query (400) is NOT retried — the request is doomed", async () => {
    // 400 that is not an emptyStatus is bad_query: retrying re-sends the same bad
    // request, so it must fail fast rather than burn the budget.
    const count = alwaysStatus(400);
    await assert.rejects(
      () => fetchProviderJson("https://x/y"),
      (err: unknown) => err instanceof ProviderError && err.reason === "bad_query",
    );
    assert.equal(count(), 1, "bad_query is not retryable");
  });
});
