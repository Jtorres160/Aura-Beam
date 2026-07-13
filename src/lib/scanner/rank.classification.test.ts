// Evidence-classification tests for the set/CN resolution paths.
//
// Bug fixed here: a verified set code + collector number that leaves exactly
// one printing is the SAME evidence whether it arrives via the direct set+CN
// database lookup (candidates.ts -> fallbackMethod "set-cn-verified") or via
// ranked narrowing over already-fetched printings (rank.ts). Both must classify
// the match as "set-cn-verified" and inherit its 0.97 confidence. Previously the
// ranked path emitted "single-art-group" (0.85) and could never auto-accept.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/rank.classification.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { decideAmongPrintings } from "@/lib/scanner/rank";
import { HeuristicScorer } from "@/lib/scanner/score";
import { METHOD_CONFIDENCE, ACCEPT_THRESHOLD_AUTOSCAN } from "@/lib/scanner/decision";
import { reading, type CandidatePrinting, type ScanEvidence } from "@/lib/scanner/evidence";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Counterspell",
    game: "MTG",
    setName: "Set",
    setCode: null,
    collectorNumber: null,
    rarity: "common",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: null,
    ...over,
  };
}

// Two printings of the same card with DISTINCT set/CN and DISTINCT artwork, so
// nothing is decided until set/CN narrowing runs.
const printings: CandidatePrinting[] = [
  printing({ externalId: "a", setName: "Modern Horizons 2", setCode: "MH2", collectorNumber: "267", illustrationId: "art-a" }),
  printing({ externalId: "b", setName: "Seventh Edition", setCode: "7ED", collectorNumber: "82", illustrationId: "art-b" }),
];

function evidenceWithSetCn(setCode: string, collectorNumber: string): ScanEvidence {
  return {
    identity: { name: reading("Counterspell", 0.85, "ocr-full") },
    printing: {
      setCode: reading(setCode, 0.95, "ocr-strip"),
      collectorNumber: reading(collectorNumber, 0.95, "ocr-strip"),
    },
  };
}

const scorer = new HeuristicScorer();

// ─── Ranked narrowing: set + CN pins one printing ────────────────────────────

test("ranked narrowing with set + collector number emits set-cn-verified", async () => {
  const decision = await decideAmongPrintings(
    printings,
    "data:image/jpeg;base64,xxx",
    { setCode: "MH2", collectorNumber: "267" },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.method, "set-cn-verified");
  assert.equal(decision.confidence, METHOD_CONFIDENCE["set-cn-verified"]);
  assert.equal(decision.printing?.externalId, "a");
});

test("collector-number key normalization still narrows (267/303 == 267)", async () => {
  const decision = await decideAmongPrintings(
    printings,
    "img",
    { setCode: "mh2", collectorNumber: "267/303" },
    null,
  );
  assert.equal(decision.method, "set-cn-verified");
  assert.equal(decision.printing?.externalId, "a");
});

// ─── Direct lookup path (candidates.ts -> scorer) ────────────────────────────

test("direct set+CN lookup classifies as set-cn-verified via the scorer", async () => {
  const verified = printings[0];
  const out = await scorer.score({
    cardName: "Counterspell",
    printings: [],
    fallbackCard: verified,
    fallbackMethod: "set-cn-verified",
    evidence: evidenceWithSetCn("MH2", "267"),
    scannedImageUrl: "img",
    learningRule: null,
  });
  assert.equal(out.decision.action, "accept");
  assert.equal(out.decision.method, "set-cn-verified");
  assert.equal(out.confidence, METHOD_CONFIDENCE["set-cn-verified"]);
});

// ─── The core equivalence: both paths agree, and both clear the bulk gate ─────

test("ranked narrowing and direct lookup produce identical evidence classification", async () => {
  const ranked = await scorer.score({
    cardName: "Counterspell",
    printings,
    fallbackCard: null,
    evidence: evidenceWithSetCn("MH2", "267"),
    scannedImageUrl: "img",
    learningRule: null,
  });
  const direct = await scorer.score({
    cardName: "Counterspell",
    printings: [],
    fallbackCard: printings[0],
    fallbackMethod: "set-cn-verified",
    evidence: evidenceWithSetCn("MH2", "267"),
    scannedImageUrl: "img",
    learningRule: null,
  });

  // Identical classification.
  assert.equal(ranked.decision.method, direct.decision.method);
  assert.equal(ranked.confidence, direct.confidence);
  assert.equal(ranked.decision.method, "set-cn-verified");

  // And the whole point of the fix: this classification clears the auto-scan
  // (bulk) acceptance gate, so a verified set/CN read auto-selects in bulk.
  assert.ok(ranked.confidence >= ACCEPT_THRESHOLD_AUTOSCAN);
  assert.ok(direct.confidence >= ACCEPT_THRESHOLD_AUTOSCAN);
});

// ─── Regression guard: set code ALONE is weaker and must NOT be promoted ──────

test("set code without collector number stays single-art-group (not promoted)", async () => {
  // Only one printing carries setCode "MH2", so set-code-alone still narrows to
  // one — but without a collector number it must keep the weaker method.
  const decision = await decideAmongPrintings(
    printings,
    "img",
    { setCode: "MH2", collectorNumber: "" },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.method, "single-art-group");
  assert.equal(decision.confidence, METHOD_CONFIDENCE["single-art-group"]);
});
