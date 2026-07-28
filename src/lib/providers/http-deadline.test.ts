// Provider transport DEADLINE tests (M5 budget bug).
//
// The rule this file locks in:
//
//   A caller's wall-clock budget must be enforceable INSIDE a retry sequence,
//   not merely between calls — and a caller that passes no deadline must be
//   completely unaffected.
//
// The failure that motivated it: catalog-sync wrapped fetchProviderJson in its
// own 3-try retry. Once fetchProviderJson gained its own 8-attempt/16s retry, the
// layers multiplied — one "list sets" call could burn ~52s of a 55s serverless
// window, and the caller's budget check (which only ran between calls) never got
// a say. The cron reported "examined: 0" while looking successful.
//
// Backoff delays are zeroed by the harness (PROVIDER_RETRY_BASE_MS=0), so these
// assert attempt COUNTS and OUTCOMES without sleeping.
//
// Run: node --import ./test/register.mjs --test src/lib/providers/http-deadline.test.ts

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchProviderJson,
  ProviderError,
  ProviderDeadlineExceeded,
} from "@/lib/providers/http";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch stub that fails after `costMs`, so elapsed time actually accrues. */
function slowFailure(status: number, costMs: number) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, costMs));
    return { ok: false, status, json: async () => ({}) } as any;
  }) as any;
  return () => calls;
}

/** A fetch stub that always returns the given status, counting calls. */
function alwaysStatus(status: number) {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as any;
  }) as any;
  return () => calls;
}

describe("deadline — the run's clock beats the call's own budget", () => {
  test("a deadline already in the past issues NO request at all", async () => {
    const count = alwaysStatus(500);
    await assert.rejects(
      () => fetchProviderJson("https://x/y", { deadline: Date.now() - 1 }),
      ProviderDeadlineExceeded,
    );
    // The point: we never even ask. A run with no time left must not spend the
    // next phase's budget discovering that for itself.
    assert.equal(count(), 0, "must not fetch once the deadline has passed");
  });

  test("a deadline mid-sequence stops the retry loop early", async () => {
    // Attempts must COST time for a deadline to bite — the harness zeroes
    // backoff, so an instant stub would (correctly) fit all 8 attempts inside
    // any deadline. 15ms per attempt against a 45ms deadline leaves room for a
    // couple, not eight.
    const count = slowFailure(500, 15);
    await assert.rejects(
      () => fetchProviderJson("https://x/y", { deadline: Date.now() + 45 }),
      (err: unknown) =>
        err instanceof ProviderError || err instanceof ProviderDeadlineExceeded,
    );
    assert.ok(
      count() < 8,
      `deadline should cut the sequence short, got ${count()} attempts`,
    );
  });

  test("with time to spare, a deadline does NOT cut the sequence short", () => {
    // The converse, so the test above can't pass for the wrong reason: a
    // deadline is a ceiling on elapsed time, not a reduction in attempts.
    return (async () => {
      const count = alwaysStatus(500);
      await assert.rejects(
        () => fetchProviderJson("https://x/y", { deadline: Date.now() + 30_000 }),
        ProviderError,
      );
      assert.equal(count(), 8, "a generous deadline must not reduce attempts");
    })();
  });

  test("a real answer still returns even with a deadline set", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ data: ["ok"] }) }) as any) as any;
    const json = await fetchProviderJson<{ data: string[] }>("https://x/y", {
      deadline: Date.now() + 10_000,
    });
    assert.deepEqual(json, { data: ["ok"] });
  });
});

describe("no deadline — scan-path behaviour is untouched", () => {
  // This is the regression guard for PR #2's measured tuning. If someone
  // "simplifies" the batch profile into the defaults, this fails.
  test("without a deadline a persistent failure still uses all 8 attempts", async () => {
    const count = alwaysStatus(500);
    await assert.rejects(() => fetchProviderJson("https://x/y"), ProviderError);
    assert.equal(count(), 8, "scan-path default must remain 8 attempts");
  });

  test("without a deadline the error is a ProviderError, never a deadline error", async () => {
    alwaysStatus(500);
    await assert.rejects(
      () => fetchProviderJson("https://x/y"),
      (err: unknown) => err instanceof ProviderError && !(err instanceof ProviderDeadlineExceeded),
    );
  });
});

describe("batch profile — fewer attempts, by explicit request", () => {
  test("maxAttempts caps the sequence below the scan-path default", async () => {
    const count = alwaysStatus(500);
    await assert.rejects(
      () => fetchProviderJson("https://x/y", { maxAttempts: 3 }),
      ProviderError,
    );
    assert.equal(count(), 3);
  });

  test("a batch caller giving up still throws the SOURCE's reason, not a deadline", async () => {
    // Truth boundary: "the source answered 500 three times" and "we ran out of
    // clock" are different facts. Exhausting attempts must report the former.
    alwaysStatus(500);
    await assert.rejects(
      () => fetchProviderJson("https://x/y", { maxAttempts: 2 }),
      (err: unknown) => err instanceof ProviderError && (err as ProviderError).reason === "http_error",
    );
  });
});
