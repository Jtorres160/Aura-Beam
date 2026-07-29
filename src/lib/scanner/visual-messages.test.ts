// ─── The art-group call's MESSAGE STRUCTURE is load-bearing ─────────────────
// These tests exist because of a defect that took three investigations to find
// and which failed silently the entire time.
//
// The candidate images used to be a bare run of images, with the mapping from
// image to letter stated only in the system prompt ("labelled a, b, c in the
// order they are attached"). That required the model to count through an image
// sequence whose FIRST element is the scanned card — and the measured result
// was a pick that was correct-or-correct+1, i.e. the model counting the scan as
// candidate "a". A +1 that stays in range is not a fall-through the collector
// can see; it is the wrong printing written into a collection silently. It hit
// 28% of the stratified corpus, and two successive reply-schema fixes (keyed
// scores, then a letter-enum pick) left it bit-for-bit unchanged.
//
// Anchoring each letter to the image directly below it fixed it: 36/36 on the
// subsetted stratum with zero wrong accepts, both reps, and the +1 population
// went 12 -> 0. See scratch/REPORT-artgroup-message-structure.md.
//
// So the invariant under test is NOT cosmetic: every candidate image must be
// immediately preceded by its own heading, and nothing may make a candidate's
// identity depend on its position in the content array. A refactor that
// re-flattens these images would silently reintroduce a 28% wrong-accept rate.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildArtGroupMessages,
  candidateHeading,
  SCANNED_CARD_HEADING,
} from "@/lib/scanner/visual";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

const SCAN = "data:image/jpeg;base64,SCANNED";

function candidates(n: number): CandidatePrinting[] {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `id-${i}`,
    name: "Test Card",
    game: "mtg",
    setName: "Test Set",
    rarity: "common",
    imageUrl: `https://example.test/full-${i}.jpg`,
    thumbnailUrl: `https://example.test/thumb-${i}.jpg`,
    price: {} as CandidatePrinting["price"],
  })) as CandidatePrinting[];
}

/** The user turn's content array — where the anchoring either exists or doesn't. */
function userParts(n: number, rule = null) {
  const messages = buildArtGroupMessages(SCAN, candidates(n), rule);
  const user = messages.find((m) => m.role === "user");
  assert.ok(user, "there must be a user message");
  assert.ok(Array.isArray(user.content), "the user content must be a parts array");
  return user.content as any[];
}

const systemText = (n: number, rule: any = null) => {
  const m = buildArtGroupMessages(SCAN, candidates(n), rule).find((x) => x.role === "system");
  return String(m!.content);
};

describe("buildArtGroupMessages — every candidate image carries its own label", () => {
  for (const n of [2, 3, 4, 5, 6]) {
    test(`N=${n}: each candidate image is immediately preceded by its own heading`, () => {
      const parts = userParts(n);
      // Layout: [scan heading, scan image, (heading, image) * N]
      assert.equal(parts.length, 2 + n * 2, "one heading per image, no bare images");

      for (let i = 0; i < n; i++) {
        const heading = parts[2 + i * 2];
        const image = parts[3 + i * 2];
        const letter = "abcdefghijklmnopqrstuvwxyz"[i];

        assert.equal(heading.type, "text");
        assert.equal(
          heading.text,
          candidateHeading(letter),
          `candidate ${i} must be introduced by "${candidateHeading(letter)}"`,
        );
        assert.equal(image.type, "image_url");
        assert.equal(
          image.image_url.url,
          `https://example.test/thumb-${i}.jpg`,
          "the image directly after a heading must be THAT candidate's image",
        );
      }
    });
  }

  test("the letter is anchored to the image below it, not to array position", () => {
    // The whole defect in one assertion: if you know a candidate's letter you
    // can find its image without counting, and the scan is not in that mapping.
    const parts = userParts(3);
    const mapping = new Map<string, string>();
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].type === "text" && parts[i + 1]?.type === "image_url") {
        mapping.set(parts[i].text, parts[i + 1].image_url.url);
      }
    }
    assert.equal(mapping.get(candidateHeading("a")), "https://example.test/thumb-0.jpg");
    assert.equal(mapping.get(candidateHeading("b")), "https://example.test/thumb-1.jpg");
    assert.equal(mapping.get(candidateHeading("c")), "https://example.test/thumb-2.jpg");
    assert.equal(mapping.get(SCANNED_CARD_HEADING), SCAN);
  });
});

describe("buildArtGroupMessages — the scanned card is not a candidate", () => {
  test("the scan leads the turn under its own heading", () => {
    const parts = userParts(4);
    assert.equal(parts[0].type, "text");
    assert.equal(parts[0].text, SCANNED_CARD_HEADING);
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[1].image_url.url, SCAN);
  });

  test("the scan's heading is never a candidate heading", () => {
    // If the scan were ever introduced as "Candidate a:", every true candidate
    // would shift by one — the exact failure this structure removes.
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    assert.ok(!letters.some((l) => candidateHeading(l) === SCANNED_CARD_HEADING));
  });

  test("the system prompt states the scan is not a candidate", () => {
    assert.match(systemText(3), /NOT a candidate/);
  });

  test("the system prompt forbids deriving a letter from image position", () => {
    assert.match(systemText(3), /[Nn]ever determine a letter by counting images/);
  });

  test("the system prompt quotes the exact headings used in the turn", () => {
    // The prompt must point at text the model can actually see. If the heading
    // format and the prompt's description of it ever drift apart, the anchor is
    // gone and only the ordering is left — which is the defect.
    const text = systemText(4);
    const parts = userParts(4);
    for (const p of parts) {
      if (p.type === "text") assert.ok(text.includes(`"${p.text}"`), `prompt must quote "${p.text}"`);
    }
  });
});

describe("buildArtGroupMessages — detail levels and the hint channel", () => {
  test("the scan is high detail and the candidates are low", () => {
    const parts = userParts(3);
    const images = parts.filter((p) => p.type === "image_url");
    assert.equal(images[0].image_url.detail, "high", "the scan must be read precisely");
    for (const img of images.slice(1)) {
      assert.equal(img.image_url.detail, "low", "candidates stay cheap");
    }
  });

  test("a HINT learning rule is appended, and nothing else is", () => {
    const withHint = systemText(2, { ruleType: "HINT", content: "check the set symbol" });
    assert.match(withHint, /IMPORTANT HINT from past scans: check the set symbol/);
    const other = systemText(2, { ruleType: "CORRECTION", content: "check the set symbol" });
    assert.ok(!other.includes("check the set symbol"));
  });

  test("the example answer is built at the live candidate width", () => {
    // A 3-wide example taught a 3-wide answer to 2- and 4-candidate questions
    // once already; that is the arity defect PR #19 fixed. Guard it here too.
    assert.match(systemText(2), /\{"pick": "a", "scores": \{"a": 0\.95, "b": 0\.25\}\}/);
    assert.match(systemText(4), /"a": 0\.95, "b": 0\.25, "c": 0\.15, "d": 0\.15/);
  });
});
