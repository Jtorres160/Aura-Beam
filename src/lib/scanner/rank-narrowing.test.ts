// ─── CN + printed-total narrowing in decideAmongPrintings ────────────────────
// The change under test: printing ranking no longer needs OCR's set-code read to
// share a vocabulary with the candidate row's stored setCode. When the two OCR
// passes independently AGREED on the collector number (reading confidence 0.95),
// the printed number pair — collectorNumberKey + setPrintedSize — narrows the
// pool by itself; the set code plays no part (a tie it could break is one the
// stronger literal set+CN path already claimed) and can never veto.
//
// The properties pinned down here, in order of how much they matter:
//
//   1. THE AGREEMENT GATE. Replayed production scans (2026-07-29) showed the
//      full-card pass hallucinating the ENTIRE number pair onto a real
//      same-name printing (Corphish printed 033/132 read as "038/163", and
//      swsh5-38 exists). A full-pass-only (0.5) or strip-only (0.75) reading
//      must therefore NEVER take this path, no matter how cleanly it pins one
//      candidate. Only two independent sensors agreeing (0.95) may.
//   2. Mixed setCode vocabularies stop mattering: a pool where rows carry
//      "BST"-style printed symbols and "sv3"-style provider slugs narrows
//      correctly with a set-code read that matches NEITHER.
//   3. Genuine ambiguity still disambiguates: a pair that pins 0 or 2+ rows
//      falls through to the user, and a disagreeing set code cannot veto a
//      unique pin.
//   4. The method is "name-cn-total-verified" (0.9): interactive auto-accept,
//      but demoted to the FULL grid (not a one-card dead end) by the bulk gate.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/rank-narrowing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPT_THRESHOLD_AUTOSCAN,
  METHOD_CONFIDENCE,
  gateDecision,
} from "@/lib/scanner/decision";
import { SET_CN_CONFIDENCE, type CandidatePrinting } from "@/lib/scanner/evidence";

// The path under test ships behind SETCODE_OPTIONAL_MATCH_ENABLED (read at
// import time in candidates.ts), so the flag must be set BEFORE rank.ts —
// which imports it — is evaluated. Everything above imports neither module.
// The flag-OFF behavior (block never entered, ranking byte-identical) is
// asserted in rank.classification.test.ts, which runs in a flag-off process.
process.env.SETCODE_OPTIONAL_MATCH_ENABLED = "1";
const { decideAmongPrintings } = await import("@/lib/scanner/rank");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Timburr",
    game: "POKEMON",
    setName: "Set",
    setCode: null,
    setPrintedSize: null,
    collectorNumber: null,
    rarity: "Common",
    // No thumbnails: a fall-through can never reach a live vision call from a
    // test (comparable < 2 short-circuits to disambiguation).
    imageUrl: null,
    thumbnailUrl: null,
    price: { marketPrice: null },
    ...over,
  };
}

/** A real failing pool shape: printed-symbol rows AND provider-slug rows side by
 *  side, exactly one of which bears the scanned number pair 73 of /163. */
const mixedPool: CandidatePrinting[] = [
  printing({ externalId: "sv6-103", setName: "Twilight Masquerade", setCode: "TWM", setPrintedSize: 167, collectorNumber: "103" }),
  printing({ externalId: "swsh5-73", setName: "Battle Styles", setCode: "BST", setPrintedSize: 163, collectorNumber: "73" }),
  printing({ externalId: "sv2-58", setName: "Paldea Evolved", setCode: "sv2", setPrintedSize: 193, collectorNumber: "58" }),
  printing({ externalId: "bw1-58", setName: "Black & White", setCode: "BLW", setPrintedSize: 114, collectorNumber: "58" }),
];

const AGREED = SET_CN_CONFIDENCE.agree;   // 0.95 — both OCR passes agreed
const FULL_ONLY = SET_CN_CONFIDENCE.full; // 0.5 — the hallucination-prone shape

// ─── 2: mixed vocabularies narrow via the number pair ────────────────────────

test("agreed CN+total narrows a mixed-vocabulary pool; set-code read matches no row", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    // "SW" is what OCR actually guessed for a Battle Styles card — it matches
    // neither "BST" nor any slug. The number pair carries the match alone.
    { setCode: "SW", collectorNumber: "073/163", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.method, "name-cn-total-verified");
  assert.equal(decision.confidence, METHOD_CONFIDENCE["name-cn-total-verified"]);
  assert.equal(decision.printing?.externalId, "swsh5-73");
  // The full pool rides along, best match first, for the bulk-gate demotion.
  assert.equal(decision.candidates?.length, mixedPool.length);
  assert.equal(decision.candidates?.[0].externalId, "swsh5-73");
  assert.equal(decision.bestMatchExternalId, "swsh5-73");
});

test("provider-slug rows are matched by the number pair too", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "PAL", collectorNumber: "058/193", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.printing?.externalId, "sv2-58");
});

test("zero-padding and whitespace in the pair still narrow (021 == 21)", async () => {
  const pool = [
    printing({ externalId: "a", setCode: "OBF", setPrintedSize: 197, collectorNumber: "21" }),
    printing({ externalId: "b", setCode: "BST", setPrintedSize: 163, collectorNumber: "21" }),
  ];
  const decision = await decideAmongPrintings(
    pool,
    "img",
    { setCode: "", collectorNumber: " 021 / 197 ", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.printing?.externalId, "a");
});

// ─── 1: the agreement gate ───────────────────────────────────────────────────

test("a full-pass-only (0.5) reading NEVER takes this path, even when it pins one row", async () => {
  // Identical evidence to the accepting test above, except provenance: this is
  // exactly the hallucinated-pair shape (Corphish 038/163) that landed on a
  // real wrong card in production. It must fall through to the user.
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "SW", collectorNumber: "073/163", collectorNumberConfidence: FULL_ONLY },
    null,
  );
  assert.equal(decision.action, "disambiguate");
});

test("a strip-only (0.75) reading falls through too", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "SW", collectorNumber: "073/163", collectorNumberConfidence: SET_CN_CONFIDENCE.strip },
    null,
  );
  assert.equal(decision.action, "disambiguate");
});

test("an absent confidence (callers without a reconciled reading) falls through", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "SW", collectorNumber: "073/163" },
    null,
  );
  assert.equal(decision.action, "disambiguate");
});

// ─── 3: genuine ambiguity stays uncertain ────────────────────────────────────

test("no printed total in the read → stands down (bare '110')", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "BST", collectorNumber: "110", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "disambiguate");
});

test("a pair matching NO row falls through — a hallucinated total finds nothing", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    // Set-code read matches no row either, so neither narrowing path can fire.
    { setCode: "SW", collectorNumber: "073/999", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "disambiguate");
});

test("2+ rows sharing the pair without set-code corroboration → user decides", async () => {
  const pool = [
    printing({ externalId: "a", setCode: "HP", setPrintedSize: 110, collectorNumber: "62" }),
    printing({ externalId: "b", setCode: "HP", setPrintedSize: 110, collectorNumber: "62" }),
  ];
  const decision = await decideAmongPrintings(
    pool,
    "img",
    // Set-code read matches BOTH rows, so it cannot break the tie either.
    { setCode: "HP", collectorNumber: "062/110", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "disambiguate");
});

test("2+ rows sharing the pair, set code matching exactly one → the LITERAL path claims it at 0.97", async () => {
  // There is deliberately no set-code tiebreak inside the pair path: a set-code
  // read that could break a tie is, by the identical comparison, one the
  // literal set+CN narrowing above already resolved — at its stronger method.
  const pool = [
    printing({ externalId: "a", setCode: "HP", setPrintedSize: 110, collectorNumber: "62" }),
    printing({ externalId: "b", setCode: "DX", setPrintedSize: 110, collectorNumber: "62" }),
  ];
  const decision = await decideAmongPrintings(
    pool,
    "img",
    { setCode: "dx", collectorNumber: "062/110", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.method, "set-cn-verified");
  assert.equal(decision.printing?.externalId, "b");
});

test("a DISAGREEING set code cannot veto a unique pair match", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    // "SV3" was the most common hallucinated set read in production — it must
    // be ignored, not allowed to reject the unique 73-of-163 match.
    { setCode: "SV3", collectorNumber: "073/163", collectorNumberConfidence: AGREED },
    null,
  );
  assert.equal(decision.action, "accept");
  assert.equal(decision.printing?.externalId, "swsh5-73");
});

test("rows without setPrintedSize (MTG/Yugioh sources) never match the pair", async () => {
  const pool = [
    printing({ externalId: "a", game: "MTG", setCode: "MH2", setPrintedSize: null, collectorNumber: "267" }),
    printing({ externalId: "b", game: "MTG", setCode: "7ED", setPrintedSize: null, collectorNumber: "82" }),
  ];
  const decision = await decideAmongPrintings(
    pool,
    "img",
    { setCode: "XX", collectorNumber: "267/303", collectorNumberConfidence: AGREED },
    null,
  );
  // Absence of a printed size is unknown, never a match — the path stands down.
  assert.equal(decision.action, "disambiguate");
});

// ─── Precedence: literal set+CN narrowing still wins unchanged ───────────────

test("the existing set-cn-verified path still runs first and is unchanged", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "BST", collectorNumber: "073/163", collectorNumberConfidence: AGREED },
    null,
  );
  // Same-vocabulary read: the stronger 0.97 path claims it before this one.
  assert.equal(decision.method, "set-cn-verified");
  assert.equal(decision.printing?.externalId, "swsh5-73");
});

// ─── 4: bulk gate demotes to the full grid, not a dead end ───────────────────

test("bulk mode demotes name-cn-total-verified to disambiguation over the FULL pool", async () => {
  const decision = await decideAmongPrintings(
    mixedPool,
    "img",
    { setCode: "SW", collectorNumber: "073/163", collectorNumberConfidence: AGREED },
    null,
  );
  assert.ok(decision.confidence < ACCEPT_THRESHOLD_AUTOSCAN);
  const gated = gateDecision(decision, true, { margin: 1, evidenceMass: 2 });
  assert.equal(gated.action, "disambiguate");
  // The whole pool survives the demotion, best match still first.
  assert.equal(gated.candidates?.length, mixedPool.length);
  assert.equal(gated.candidates?.[0].externalId, "swsh5-73");
  assert.equal(gated.bestMatchExternalId, "swsh5-73");
});
