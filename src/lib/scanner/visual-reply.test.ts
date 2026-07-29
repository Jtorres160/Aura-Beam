// Vision reply contract tests.
//
// pickArtGroupByVision is a sensor: it reports what the model said, and the
// ranking layer decides what that means. These tests cover the seam where a
// reply becomes a reading — the only place this module makes a judgement — and
// they exist because two defects lived there undetected:
//
//   1. `scores` arity. The model was asked for an array whose length it had to
//      count, and got it wrong on 81 of 378 logged replies, always by +1. The
//      whole reply was then discarded before `index` was read. Arity is now
//      keyed and schema-enforced; the parser's job is to reject a wrong-width
//      reply, NEVER to trim one to fit (see the margin test below).
//   2. `parsed.index` without optional chaining, so a reply of the literal text
//      "null" threw and was logged as a transport error.
//
// What is deliberately NOT tested here, because it is deliberately not fixed
// here: whether `index` is 0- or 1-based. That defect is real and unresolved,
// and the tests assert `index` passes through untouched precisely so a future
// change to it shows up as a test change.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/visual-reply.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decodeScores, decodeVisionReply } from "@/lib/scanner/visual";

/** The keyed shape the json_schema now requires, for N candidates. */
const keyed = (scores: number[]) =>
  Object.fromEntries(scores.map((s, i) => ["abcdefghijklmnopqrstuvwxyz"[i], s]));

describe("decodeScores — arity is exact, in both shapes", () => {
  test("a keyed object of the right width decodes in candidate order", () => {
    assert.deepEqual(decodeScores({ a: 0.9, b: 0.2, c: 0.1 }, 3), [0.9, 0.2, 0.1]);
  });

  test("key order in the reply does not change candidate order", () => {
    // JSON object key order is not guaranteed to survive the model or the
    // wire; position must come from the key itself, not from insertion order.
    assert.deepEqual(decodeScores({ c: 0.1, a: 0.9, b: 0.2 }, 3), [0.9, 0.2, 0.1]);
  });

  test("a bare array of the right length is still accepted", () => {
    // Pre-schema replies must remain readable rather than be thrown away.
    assert.deepEqual(decodeScores([0.9, 0.2], 2), [0.9, 0.2]);
  });

  test("an over-wide array is rejected, not trimmed", () => {
    // The measured defect: N+1 scores. Trimming moves rank.ts's decision margin
    // on 90% of long arrays and crosses decision.ts's MARGIN_FLOOR on 77%, so
    // recovering the reply this way would move a live gate. Rejection is the
    // honest outcome — it routes the scan to user disambiguation.
    assert.equal(decodeScores([0.9, 0.2, 0.1], 2), null);
  });

  test("an over-wide keyed object is rejected too", () => {
    assert.equal(decodeScores({ a: 0.9, b: 0.2, c: 0.1 }, 2), null);
  });

  test("a right-width object missing a candidate's key is rejected", () => {
    // Same width, wrong keys: "d" is not a candidate when there are 3.
    assert.equal(decodeScores({ a: 0.9, b: 0.2, d: 0.1 }, 3), null);
  });

  test("under-wide replies are rejected", () => {
    assert.equal(decodeScores([0.9], 2), null);
    assert.equal(decodeScores({ a: 0.9 }, 2), null);
  });

  test("out-of-range and non-numeric scores are rejected", () => {
    assert.equal(decodeScores([1.4, 0.2], 2), null);
    assert.equal(decodeScores([-0.1, 0.2], 2), null);
    assert.equal(decodeScores({ a: "high", b: 0.2 }, 2), null);
    assert.equal(decodeScores([NaN, 0.2], 2), null);
  });

  test("missing scores is rejected, not treated as an empty reading", () => {
    assert.equal(decodeScores(undefined, 2), null);
    assert.equal(decodeScores(null, 2), null);
  });
});

describe("decodeVisionReply — -1 passes through untouched", () => {
  test("-1 is preserved as -1, never mapped onto a candidate", () => {
    // -1 means "none of these match". rank.ts routes it to disambiguation.
    // Mapping it to a real index would convert honest uncertainty into a
    // wrong accept the collector never sees — the one failure mode the
    // scanner must not have.
    const decoded = decodeVisionReply({ index: -1, scores: keyed([0.1, 0.05]) }, 2);
    assert.equal(decoded.outcome, "accepted-none-match");
    assert.equal(decoded.result?.index, -1);
  });

  test("-1 survives even when one score is a confident winner", () => {
    // The scores must not be allowed to overrule the stated -1 by argmax.
    const decoded = decodeVisionReply({ index: -1, scores: keyed([0.95, 0.1, 0.05]) }, 3);
    assert.equal(decoded.outcome, "accepted-none-match");
    assert.equal(decoded.result?.index, -1);
    assert.deepEqual(decoded.result?.scores, [0.95, 0.1, 0.05]);
  });

  test("-1 with a malformed scores width is still rejected as malformed", () => {
    // -1 is not a licence to skip validation; a reply we cannot read is a
    // reply we cannot read, and it lands in the same telemetry bucket.
    const decoded = decodeVisionReply({ index: -1, scores: [0.1, 0.05, 0.02] }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.result, null);
  });
});

describe("decodeVisionReply — index is reported, not corrected", () => {
  test("an in-range index is passed through exactly as reported", () => {
    const decoded = decodeVisionReply({ index: 1, scores: keyed([0.2, 0.9, 0.1]) }, 3);
    assert.equal(decoded.outcome, "accepted");
    assert.equal(decoded.result?.index, 1, "index must not be shifted or realigned");
  });

  test("an index of N is rejected as out of range, not silently realigned", () => {
    // A 1-based reply naming the last candidate arrives as index === N. Whether
    // to realign it is an open, unvalidated question against the benchmark
    // corpus. Until that is measured, the honest outcome is a labelled
    // rejection — and this test is what a realignment change has to come
    // through, so it cannot be introduced quietly.
    const decoded = decodeVisionReply({ index: 3, scores: keyed([0.2, 0.1, 0.9]) }, 3);
    assert.equal(decoded.outcome, "rejected-index-out-of-range");
    assert.equal(decoded.result, null);
    assert.equal(decoded.shape.index, 3, "the raw index is still reported to telemetry");
  });

  test("the index is never replaced by the argmax of its own scores", () => {
    // A pick that contradicts its own evidence is recorded (shape.scoresArgmax)
    // but not overridden — substituting argmax was measured at 35% vs 29%,
    // which is noise, not a fix.
    const decoded = decodeVisionReply({ index: 0, scores: keyed([0.2, 0.9]) }, 2);
    assert.equal(decoded.result?.index, 0);
    assert.equal(decoded.shape.scoresArgmax, 1, "the disagreement is reported");
  });
});

describe("decodeVisionReply — unusable replies are labelled, not thrown", () => {
  test('a reply of literal "null" is malformed, not an error', () => {
    // JSON.parse("null") succeeds and yields null. Reading `.index` off it used
    // to throw into the outer catch, where it was logged as outcome=error and
    // blamed on the transport. A reply we could read but not use is a
    // reply-shape defect, and the telemetry has to be able to tell them apart.
    const decoded = decodeVisionReply(JSON.parse("null"), 3);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.result, null);
    assert.equal(decoded.shape.index, undefined);
    assert.equal(decoded.shape.scoresLen, undefined);
  });

  test("a bare JSON scalar or array body is malformed, not an error", () => {
    for (const body of [JSON.parse("7"), JSON.parse('"none"'), JSON.parse("[]")]) {
      assert.equal(decodeVisionReply(body, 3).outcome, "rejected-malformed");
    }
  });

  test("a non-numeric index is malformed", () => {
    const decoded = decodeVisionReply({ index: "0", scores: keyed([0.9, 0.1]) }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.shape.index, undefined);
  });

  test("a rejected reply still reports its width so the defect is diagnosable", () => {
    // scoresLen vs candidate count is the discriminator that told us the arity
    // defect existed at all; it must survive the rejection path.
    const decoded = decodeVisionReply({ index: 0, scores: [0.9, 0.2, 0.1] }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.shape.scoresLen, 3);
    assert.equal(decoded.shape.index, 0);
  });

  test("a keyed reply's width is reported too", () => {
    const decoded = decodeVisionReply({ index: 0, scores: { a: 0.9, b: 0.2, c: 0.1 } }, 2);
    assert.equal(decoded.shape.scoresLen, 3);
  });
});
