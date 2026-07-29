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
//   3. The pick's index BASE. The model was asked for `{"index": N}`, a number
//      whose base it had to infer, and measured over the 49-entry stratified
//      corpus the reported index was always either the correct candidate or the
//      correct candidate + 1, with the base unstable even between two photos of
//      one card. Since a 1-based answer only falls out of range when the correct
//      candidate is LAST, first/middle positions produced silent wrong accepts —
//      10 of 36 subsetted corpus entries. The pick is now a LABEL over the same
//      letters `scores` is keyed by, enum-constrained in the strict schema, so
//      there is no base for the model to infer. These tests pin the label
//      resolution and, above all, that "none" survives it.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/visual-reply.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decodePick, decodeScores, decodeVisionReply, NONE_MATCH_LABEL } from "@/lib/scanner/visual";

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

describe("decodePick — a label resolves to a position, with no base to infer", () => {
  test("letters resolve to their position in candidate order", () => {
    assert.deepEqual(decodePick("a", 3), { outcome: "ok", index: 0 });
    assert.deepEqual(decodePick("b", 3), { outcome: "ok", index: 1 });
    assert.deepEqual(decodePick("c", 3), { outcome: "ok", index: 2 });
  });

  test('"none" resolves to -1 at any candidate count', () => {
    for (const n of [2, 3, 6]) {
      assert.deepEqual(decodePick(NONE_MATCH_LABEL, n), { outcome: "ok", index: -1 });
    }
  });

  test("case and surrounding whitespace do not change the answer", () => {
    // A letter names the same candidate whatever its case. Unlike a number, it
    // carries no base for this normalisation to get wrong.
    assert.deepEqual(decodePick(" B ", 3), { outcome: "ok", index: 1 });
    assert.deepEqual(decodePick("NONE", 3), { outcome: "ok", index: -1 });
  });

  test("a letter naming no live candidate is out of range, not clamped", () => {
    // "d" of 3 candidates. The strict enum should make this unreachable; if it
    // ever arrives it must be a labelled rejection, never rounded to "c".
    assert.deepEqual(decodePick("d", 3), { outcome: "out-of-range" });
  });

  test("a number is NOT accepted as a pick", () => {
    // The whole point of the change: numbers carry a base, labels do not. A
    // numeric pick in the pick field is a contract violation, not a shortcut.
    assert.deepEqual(decodePick(0, 3), { outcome: "malformed" });
    assert.deepEqual(decodePick("0", 3), { outcome: "malformed" });
    assert.deepEqual(decodePick("1", 3), { outcome: "malformed" });
  });

  test("nonsense labels are malformed", () => {
    for (const bad of ["", "ab", "?", null, undefined, {}]) {
      assert.equal(decodePick(bad, 3).outcome, "malformed");
    }
  });
});

describe('decodeVisionReply — "none" passes through untouched', () => {
  test('"none" becomes -1, never mapped onto a candidate', () => {
    // -1 means "none of these match". rank.ts routes it to disambiguation.
    // Mapping it to a real index would convert honest uncertainty into a
    // wrong accept the collector never sees — the one failure mode the
    // scanner must not have.
    const decoded = decodeVisionReply({ pick: NONE_MATCH_LABEL, scores: keyed([0.1, 0.05]) }, 2);
    assert.equal(decoded.outcome, "accepted-none-match");
    assert.equal(decoded.result?.index, -1);
  });

  test('"none" survives even when one score is a confident winner', () => {
    // The scores must not be allowed to overrule the stated "none" by argmax.
    const decoded = decodeVisionReply({ pick: NONE_MATCH_LABEL, scores: keyed([0.95, 0.1, 0.05]) }, 3);
    assert.equal(decoded.outcome, "accepted-none-match");
    assert.equal(decoded.result?.index, -1);
    assert.deepEqual(decoded.result?.scores, [0.95, 0.1, 0.05]);
  });

  test('"none" with a malformed scores width is still rejected as malformed', () => {
    // "none" is not a licence to skip validation; a reply we cannot read is a
    // reply we cannot read, and it lands in the same telemetry bucket.
    const decoded = decodeVisionReply({ pick: NONE_MATCH_LABEL, scores: [0.1, 0.05, 0.02] }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.result, null);
  });

  test("a legacy numeric -1 still means none", () => {
    const decoded = decodeVisionReply({ index: -1, scores: keyed([0.1, 0.05]) }, 2);
    assert.equal(decoded.outcome, "accepted-none-match");
    assert.equal(decoded.result?.index, -1);
  });
});

describe("decodeVisionReply — the label is resolved, never realigned", () => {
  test("a label resolves to its own position", () => {
    const decoded = decodeVisionReply({ pick: "b", scores: keyed([0.2, 0.9, 0.1]) }, 3);
    assert.equal(decoded.outcome, "accepted");
    assert.equal(decoded.result?.index, 1);
    assert.equal(decoded.shape.pick, "b", "the raw label is reported to telemetry");
  });

  test("the LAST label resolves to the last candidate, not off the end", () => {
    // This is the case the old numeric contract got wrong: a 1-based reply
    // naming the last candidate arrived as index === N and was rejected. There
    // is no such failure mode for a label — "c" of 3 is simply index 2.
    const decoded = decodeVisionReply({ pick: "c", scores: keyed([0.2, 0.1, 0.9]) }, 3);
    assert.equal(decoded.outcome, "accepted");
    assert.equal(decoded.result?.index, 2);
  });

  test("the FIRST label resolves to 0, with no off-by-one either way", () => {
    const decoded = decodeVisionReply({ pick: "a", scores: keyed([0.9, 0.1, 0.2]) }, 3);
    assert.equal(decoded.result?.index, 0);
  });

  test("a label naming no live candidate is rejected as out of range", () => {
    const decoded = decodeVisionReply({ pick: "d", scores: keyed([0.2, 0.1, 0.9]) }, 3);
    assert.equal(decoded.outcome, "rejected-index-out-of-range");
    assert.equal(decoded.result, null);
    assert.equal(decoded.shape.pick, "d", "the raw label is still reported to telemetry");
  });

  test("the pick is never replaced by the argmax of its own scores", () => {
    // A pick that contradicts its own evidence is recorded (shape.scoresArgmax)
    // but not overridden. argmax was measured NOISIER on identity than the pick
    // (20/36 subsetted, 1/10 on middle-position cells) — it is telemetry, not a
    // fallback, and nothing may promote it to one.
    const decoded = decodeVisionReply({ pick: "a", scores: keyed([0.2, 0.9]) }, 2);
    assert.equal(decoded.result?.index, 0);
    assert.equal(decoded.shape.scoresArgmax, 1, "the disagreement is reported");
  });

  test("a legacy numeric index is still read, and still not realigned", () => {
    // Unreachable under the strict schema, but if a pre-schema reply arrives it
    // is read as reported. It is emphatically NOT given the realignment that was
    // measured and refuted against the corpus.
    assert.equal(decodeVisionReply({ index: 1, scores: keyed([0.2, 0.9, 0.1]) }, 3).result?.index, 1);
    const outOfRange = decodeVisionReply({ index: 3, scores: keyed([0.2, 0.1, 0.9]) }, 3);
    assert.equal(outOfRange.outcome, "rejected-index-out-of-range");
    assert.equal(outOfRange.result, null);
  });

  test("pick wins when a reply somehow carries both fields", () => {
    // Only one field is the contract. If both appear, the label is authoritative
    // — falling back to the number would reopen the base defect.
    const decoded = decodeVisionReply({ pick: "c", index: 0, scores: keyed([0.1, 0.2, 0.9]) }, 3);
    assert.equal(decoded.result?.index, 2);
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
    assert.equal(decoded.shape.pick, undefined);
    assert.equal(decoded.shape.scoresLen, undefined);
  });

  test("a bare JSON scalar or array body is malformed, not an error", () => {
    for (const body of [JSON.parse("7"), JSON.parse('"none"'), JSON.parse("[]")]) {
      assert.equal(decodeVisionReply(body, 3).outcome, "rejected-malformed");
    }
  });

  test("a reply with no pick and no index is malformed", () => {
    const decoded = decodeVisionReply({ scores: keyed([0.9, 0.1]) }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.shape.index, undefined);
  });

  test("a non-string pick is malformed", () => {
    const decoded = decodeVisionReply({ pick: 0, scores: keyed([0.9, 0.1]) }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.shape.index, undefined);
  });

  test("a rejected reply still reports its width so the defect is diagnosable", () => {
    // scoresLen vs candidate count is the discriminator that told us the arity
    // defect existed at all; it must survive the rejection path.
    const decoded = decodeVisionReply({ pick: "a", scores: [0.9, 0.2, 0.1] }, 2);
    assert.equal(decoded.outcome, "rejected-malformed");
    assert.equal(decoded.shape.scoresLen, 3);
    assert.equal(decoded.shape.pick, "a");
  });

  test("a keyed reply's width is reported too", () => {
    const decoded = decodeVisionReply({ pick: "a", scores: { a: 0.9, b: 0.2, c: 0.1 } }, 2);
    assert.equal(decoded.shape.scoresLen, 3);
  });
});
