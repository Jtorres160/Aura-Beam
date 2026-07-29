// throttleVision span-attribution tests (Phase 5.17C).
//
// The spans exist to answer one question that production telemetry could not:
// when a vision call takes 9.9s, how much of that was the MODEL and how much
// was our own 429 backoff? So the tests that matter are that the three buckets
// stay separated, that they are reported on the give-up path as well as the
// happy path, and — most importantly — that this instrumentation cannot change
// what the caller receives.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/vision-throttle.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { throttleVision, type VisionCallSpans } from "@/lib/scanner/vision-throttle";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 429 shaped like the SDK's, with the server's retry hint in the message. */
function rateLimitError(hintMs: number): Error & { status: number } {
  const err = new Error(`Rate limit reached. Please try again in ${hintMs}ms`) as Error & { status: number };
  err.status = 429;
  return err;
}

describe("throttleVision — span attribution", () => {
  test("a clean call reports its time as callMs, not gate or backoff", async () => {
    let spans: VisionCallSpans | null = null;
    const result = await throttleVision(async () => {
      await sleep(60);
      return "ok";
    }, (s) => { spans = s; });

    assert.equal(result, "ok");
    const seen = spans as VisionCallSpans | null;
    assert.ok(seen, "onSpans should have been invoked");
    assert.equal(seen!.attempts, 1);
    assert.equal(seen!.backoffMs, 0, "no 429 means no backoff");
    assert.ok(seen!.callMs >= 50, `callMs should cover the call (got ${seen!.callMs})`);
  });

  test("429 refill waiting lands in backoffMs, kept separate from callMs", async () => {
    let spans: VisionCallSpans | null = null;
    let attempts = 0;
    const result = await throttleVision(async () => {
      attempts++;
      if (attempts === 1) throw rateLimitError(300);
      return "recovered";
    }, (s) => { spans = s; });

    assert.equal(result, "recovered");
    const seen = spans as VisionCallSpans | null;
    assert.equal(seen!.attempts, 2, "one retry after the 429");
    assert.ok(seen!.backoffMs > 0, "the refill wait must be attributed to backoffMs");
    // This is the whole point: a slow-looking call that was really us waiting.
    assert.ok(
      seen!.backoffMs > seen!.callMs,
      `backoff (${seen!.backoffMs}ms) should dominate two instant calls (${seen!.callMs}ms)`
    );
  });

  test("spans are reported on the give-up path too", async () => {
    let spans: VisionCallSpans | null = null;
    await assert.rejects(
      throttleVision(async () => { throw rateLimitError(50); }, (s) => { spans = s; }),
      (err: any) => err.status === 429
    );
    const seen = spans as VisionCallSpans | null;
    assert.ok(seen, "a call that exhausts its retries must still report");
    assert.ok(seen!.attempts >= 1);
  });

  test("a non-429 error rethrows untouched and still reports", async () => {
    let spans: VisionCallSpans | null = null;
    const boom = new Error("connection reset");
    await assert.rejects(
      throttleVision(async () => { throw boom; }, (s) => { spans = s; }),
      (err: any) => err === boom
    );
    assert.equal((spans as VisionCallSpans | null)?.attempts, 1, "non-429 must not retry");
  });
});

describe("throttleVision — instrumentation cannot affect the result", () => {
  test("omitting onSpans behaves identically", async () => {
    const result = await throttleVision(async () => ({ choices: [1, 2] }));
    assert.deepEqual(result, { choices: [1, 2] });
  });

  test("a throwing onSpans callback does not break the call", async () => {
    const result = await throttleVision(
      async () => "unharmed",
      () => { throw new Error("instrumentation bug"); }
    );
    assert.equal(result, "unharmed", "a broken span reporter must never fail a scan");
  });
});
