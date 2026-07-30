import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseScanFeedback,
  SCAN_FEEDBACK_CATEGORIES,
  SCAN_FEEDBACK_LABELS,
  SCAN_FEEDBACK_MESSAGE_MAX,
} from "@/lib/scanner/scan-feedback";

const ok = (body: unknown) => {
  const r = parseScanFeedback(body);
  assert.ok(r.ok, `expected parse to succeed, got: ${r.ok ? "" : r.message}`);
  return r.value;
};

test("a category and a surface are enough for a valid report", () => {
  const v = ok({ category: "wrong-card", surface: "result" });
  assert.equal(v.category, "wrong-card");
  assert.equal(v.surface, "result");
  assert.equal(v.message, null);
});

test("an unrecognized category is rejected, never coerced", () => {
  // The whole value of the category column is that its distribution can be
  // trusted; silently bucketing an unknown value as "other" would destroy that.
  const r = parseScanFeedback({ category: "totally-made-up", surface: "result" });
  assert.equal(r.ok, false);
});

test("an unrecognized surface is rejected", () => {
  const r = parseScanFeedback({ category: "wrong-card", surface: "sidebar" });
  assert.equal(r.ok, false);
});

test("missing context becomes null, never a placeholder", () => {
  const v = ok({ category: "scan-failed", surface: "error" });
  for (const field of ["scanId", "cardId", "cardName", "matchMethod", "failureStage", "game"] as const) {
    assert.equal(v[field], null, `${field} should be null when absent`);
  }
  assert.equal(v.confidence, null);
});

test("blank and whitespace-only strings are absent, not empty", () => {
  const v = ok({ category: "other", surface: "result", cardName: "   ", message: "  \n " });
  assert.equal(v.cardName, null);
  assert.equal(v.message, null);
});

test("context strings are trimmed and kept", () => {
  const v = ok({
    category: "wrong-printing",
    surface: "result",
    scanId: " scan_123 ",
    cardId: "card_456",
    cardName: " Lightning Bolt ",
    matchMethod: "set-cn-verified",
    game: "MTG",
  });
  assert.equal(v.scanId, "scan_123");
  assert.equal(v.cardName, "Lightning Bolt");
  assert.equal(v.matchMethod, "set-cn-verified");
});

test("confidence is stored only when it is a real 0-100 reading", () => {
  assert.equal(ok({ category: "other", surface: "result", confidence: 97 }).confidence, 97);
  assert.equal(ok({ category: "other", surface: "result", confidence: 0 }).confidence, 0);
  assert.equal(ok({ category: "other", surface: "result", confidence: 96.6 }).confidence, 97);
  // Out of range, wrong type and non-finite all mean "we have no reading".
  for (const bad of [-1, 101, NaN, Infinity, "97", null, undefined]) {
    assert.equal(
      ok({ category: "other", surface: "result", confidence: bad }).confidence,
      null,
      `confidence ${String(bad)} should be null`,
    );
  }
});

test("an over-long message is rejected rather than silently truncated", () => {
  // Truncating would store a report whose text is not what the person wrote,
  // and tell them it was received in full.
  const r = parseScanFeedback({
    category: "other",
    surface: "result",
    message: "x".repeat(SCAN_FEEDBACK_MESSAGE_MAX + 1),
  });
  assert.equal(r.ok, false);
  assert.ok(ok({ category: "other", surface: "result", message: "x".repeat(SCAN_FEEDBACK_MESSAGE_MAX) }));
});

test("a null or non-object body is rejected, not treated as empty", () => {
  for (const body of [null, undefined, "string", 42, []]) {
    assert.equal(parseScanFeedback(body).ok, false, `${JSON.stringify(body)} should be rejected`);
  }
});

test("every category has a label a collector can read", () => {
  for (const c of SCAN_FEEDBACK_CATEGORIES) {
    assert.ok(SCAN_FEEDBACK_LABELS[c]?.length > 0, `${c} has no label`);
  }
});
