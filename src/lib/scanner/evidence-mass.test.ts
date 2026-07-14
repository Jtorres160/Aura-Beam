// EvidenceMass expansion tests (Phase 5.5, Batch 3).
//
// These tests define the CONTRACT for the identity-evidence layer. The rule
// they lock in:
//
//   Vision is a sensor. EvidenceMass is independent identity confirmation.
//   More independent identity confirmation wins — a confident vision guess
//   never overrides stronger deterministic evidence, and contradictory OCR
//   is a penalty, not noise to ignore.
//
// Deliberate design choices in this file:
//   • Assertions compare EvidenceMass RELATIVELY (massA > massB), never against
//     a hard-coded point total. The model may evolve from a flat count into
//     weighted signals (e.g. collectorNumber=2.0, set=1.5, rarity=0.5); the
//     invariant is the ordering, not the arithmetic.
//   • Vision scores appear only in COMMENTS. The evidence layer never sees them.
//     If a future refactor blends vision into mass, these tests still hold —
//     which is exactly what stops `finalScore = vision*0.8 + evidence*0.2`.
//   • Artwork identity is one evidence signal among several, fed by the artwork
//     BOUNDARY (deterministic illustrationId), NOT by the vision comparison.
//     They are separate sensors and must never be double-counted.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/evidence-mass.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assessArtworkBoundary,
  assessIdentitySignals,
  calculateEvidenceMass,
  reading,
  type CandidatePrinting,
  type ScanEvidence,
} from "@/lib/scanner/evidence";
import {
  gateDecision,
  acceptDecision,
  MARGIN_FLOOR,
  type Decision,
} from "@/lib/scanner/decision";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Charizard ex",
    game: "POKEMON",
    setName: "Obsidian Flames",
    setCode: null,
    collectorNumber: null,
    rarity: "rare",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: null,
    ...over,
  };
}

/** Build the OCR/vision evidence read off ONE scanned card. Only the fields
 *  passed were "read"; everything else is genuinely unobserved (undefined). */
function evidence(over: {
  name?: string;
  setCode?: string;
  collectorNumber?: string;
  rarity?: string;
  illustrationId?: string;
}): ScanEvidence {
  return {
    identity: {
      name: over.name !== undefined ? reading(over.name, 0.9, "ocr-full") : undefined,
    },
    printing: {
      setCode: over.setCode !== undefined ? reading(over.setCode, 0.9, "ocr-strip") : undefined,
      collectorNumber:
        over.collectorNumber !== undefined ? reading(over.collectorNumber, 0.9, "ocr-strip") : undefined,
      rarity: over.rarity !== undefined ? reading(over.rarity, 0.9, "ocr-strip") : undefined,
      illustrationId:
        over.illustrationId !== undefined ? reading(over.illustrationId, 0.9, "vision-compare") : undefined,
    },
  };
}

/** Convenience: mass of a candidate under a shared body of scan evidence. */
function massOf(ev: ScanEvidence, candidate: CandidatePrinting): number {
  return calculateEvidenceMass(assessIdentitySignals(ev, candidate));
}

// ═══════════════════════════════════════════════════════════════════════════
//  EvidenceMass expansion — the identity-layer contract
// ═══════════════════════════════════════════════════════════════════════════

describe("EvidenceMass expansion", () => {
  // ─── Test 1 ────────────────────────────────────────────────────────────────
  // Strong identity evidence outweighs an uncertain vision guess.
  test("strong identity evidence beats weak vision", () => {
    // Scanned card reads: MH2-style set/CN/rarity all pointing at printing A.
    const ev = evidence({
      name: "Charizard ex",
      setCode: "OBF",
      collectorNumber: "125",
      rarity: "rare",
      illustrationId: "art-a",
    });

    // Candidate A: every identity field agrees.  (Vision would score this ~0.55)
    const candidateA = printing({
      externalId: "a",
      setCode: "OBF",
      collectorNumber: "125",
      rarity: "rare",
      illustrationId: "art-a",
    });

    // Candidate B: only the name agrees; set + CN + artwork all contradict.
    // (Vision would score this ~0.90 — the trap we must NOT fall for.)
    const candidateB = printing({
      externalId: "b",
      setCode: "PAF",
      collectorNumber: "234",
      rarity: "rare",
      illustrationId: "art-b",
    });

    const massA = massOf(ev, candidateA);
    const massB = massOf(ev, candidateB);

    assert.ok(
      massA > massB,
      `Identity-complete candidate A (${massA}) must outweigh vision-favored B (${massB})`,
    );
  });

  // ─── Test 2 ────────────────────────────────────────────────────────────────
  // The explicit "vision-only trap": a near-perfect vision score with almost no
  // identity evidence must LOSE to a modest vision score backed by a full stack.
  test("vision confidence cannot dominate identity evidence", () => {
    // Scan read name + set + CN + artwork identity. (Rarity left unread so it is
    // a neutral unknown for both candidates and can't incidentally pad A.)
    const ev = evidence({
      name: "Charizard ex",
      setCode: "OBF",
      collectorNumber: "125",
      illustrationId: "art-real",
    });

    // Candidate A — the seductive one. Vision LOVES it (0.98) but the only thing
    // that actually agrees is the name; every printing-level field is unknown.
    const candidateA = printing({
      externalId: "a",
      setCode: null,
      collectorNumber: null,
      illustrationId: null, // no deterministic artwork identity to confirm
    });

    // Candidate B — vision is lukewarm (0.65) but name + set + CN + rarity +
    // artwork identity ALL independently confirm it.
    const candidateB = printing({
      externalId: "b",
      setCode: "OBF",
      collectorNumber: "125",
      rarity: "rare",
      illustrationId: "art-real",
    });

    const massA = massOf(ev, candidateA);
    const massB = massOf(ev, candidateB);

    assert.ok(
      massB > massA,
      `Five independent confirmations (B=${massB}) must beat name-only + high vision (A=${massA}). ` +
        `A weighted blend of vision*0.8 + evidence*0.2 would wrongly pick A — that is the regression this guards.`,
    );
  });

  // ─── Test 3 ────────────────────────────────────────────────────────────────
  // Independent signals stack: additional agreeing fields strictly increase mass.
  test("independent signals stack", () => {
    const ev = evidence({
      name: "Charizard ex",
      setCode: "OBF",
      collectorNumber: "125",
      rarity: "rare",
      illustrationId: "art-a",
    });

    // Full stack: name + set + CN + rarity + artwork all agree.
    const full = printing({
      externalId: "full",
      setCode: "OBF",
      collectorNumber: "125",
      rarity: "rare",
      illustrationId: "art-a",
    });

    // Partial stack: name + set + artwork agree; CN + rarity simply unread on
    // THIS candidate's side is impossible (we share evidence), so instead this
    // candidate leaves CN/rarity absent — those become neutral unknowns, not
    // contradictions. Fewer confirmations ⇒ strictly less mass.
    const partial = printing({
      externalId: "partial",
      setCode: "OBF",
      collectorNumber: null,
      rarity: "rare", // present but we compare against evidence below
      illustrationId: "art-a",
    });
    // Re-score `partial` against evidence that omits CN so the missing field is a
    // genuine unknown on both sides (nothing to contradict).
    const evNoCn = evidence({
      name: "Charizard ex",
      setCode: "OBF",
      rarity: "rare",
      illustrationId: "art-a",
    });

    const massFull = massOf(ev, full);
    const massPartial = massOf(evNoCn, partial);

    assert.ok(
      massFull > massPartial,
      `A five-signal stack (${massFull}) must exceed a three-signal stack (${massPartial})`,
    );
  });

  // ─── Test 4 ────────────────────────────────────────────────────────────────
  // Contradiction is a strict penalty. The clean, weight-agnostic proof is a
  // three-way ordering under ONE body of evidence:
  //     match  >  unknown  >  mismatch
  // i.e. a contradicting field is strictly worse than simply not knowing it.
  test("contradictions reduce evidence strength", () => {
    // Scan read name + set + CN. (Rarity/art deliberately unread — neutral for all.)
    const ev = evidence({
      name: "Charizard ex",
      setCode: "OBF",
      collectorNumber: "125",
    });

    // All fields agree.
    const consistent = printing({
      externalId: "consistent",
      setCode: "OBF",
      collectorNumber: "125",
    });

    // Set + CN unknown on the candidate → neutral, no confirmation, no penalty.
    const neutral = printing({
      externalId: "neutral",
      setCode: null,
      collectorNumber: null,
    });

    // Set + CN present but WRONG → active contradiction. (Vision could still
    // score this high; it must not rescue the contradiction.)
    const contradictory = printing({
      externalId: "contradictory",
      setCode: "PAF",
      collectorNumber: "999",
    });

    const massConsistent = massOf(ev, consistent);
    const massNeutral = massOf(ev, neutral);
    const massContradictory = massOf(ev, contradictory);

    assert.ok(
      massConsistent > massNeutral,
      `Agreeing evidence (${massConsistent}) must beat unknown (${massNeutral})`,
    );
    assert.ok(
      massNeutral > massContradictory,
      `Unknown (${massNeutral}) must beat contradiction (${massContradictory}) — ` +
        `a mismatch is strictly worse than an absent field`,
    );
  });

  // ─── Test 5 ────────────────────────────────────────────────────────────────
  // Unknown fields stay neutral (never negative). Critical for Pokémon, whose
  // data source provides no illustrationId — absence must not read as mismatch.
  test("unknown fields remain neutral", () => {
    // Scan read name + set + CN, but NO artwork identity (Pokémon: none exists).
    const ev = evidence({
      name: "Charizard ex",
      setCode: "OBF",
      collectorNumber: "125",
    });

    // A: name + set + CN agree; illustrationId genuinely unknown (null source).
    const candidateA = printing({
      externalId: "a",
      setCode: "OBF",
      collectorNumber: "125",
      illustrationId: null,
    });

    // B: same, but collector number CONTRADICTS.
    const candidateB = printing({
      externalId: "b",
      setCode: "OBF",
      collectorNumber: "999",
      illustrationId: null,
    });

    const signalsA = assessIdentitySignals(ev, candidateA);
    const artSignalA = signalsA.find((s) => s.type === "artwork");

    // The unknown artwork field must be classified "unknown", not "mismatch".
    assert.ok(artSignalA, "artwork signal should be present");
    assert.equal(
      artSignalA?.state,
      "unknown",
      "Missing artwork identity must be neutral (unknown), never a mismatch",
    );

    // And the mismatch on B (not the unknown art on A) is what separates them.
    const massA = calculateEvidenceMass(signalsA);
    const massB = massOf(ev, candidateB);
    assert.ok(
      massA > massB,
      `Unknown art must not penalize A (${massA}); only B's real CN mismatch should (${massB})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Regression protection — Batch 2 gates must survive the evidence expansion
// ═══════════════════════════════════════════════════════════════════════════

describe("EvidenceMass regression protection", () => {
  // ─── Regression 1 ────────────────────────────────────────────────────────────
  // The critical guard: a HIGH EvidenceMass must NOT bypass the artwork-boundary
  // gate. If someone later writes `if (evidenceMass > threshold) autoAccept()`,
  // this fails. Pokémon + narrow art margin still routes to user selection even
  // when identity evidence is otherwise strong.
  test("Pokemon narrow artwork margin still requires selection", () => {
    const candidates = [
      printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
      printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
    ];

    const decision: Decision = {
      ...acceptDecision(candidates[0], "art-group-vision"),
      candidates,
      artworkBoundary: assessArtworkBoundary("POKEMON"),
    };

    // High evidenceMass (5) MUST NOT override the artwork-uncertainty gate.
    const gated = gateDecision(decision, false, { margin: 0.08, evidenceMass: 5 });

    assert.equal(
      gated.action,
      "disambiguate",
      "Narrow Pokémon art margin must still demote to user selection despite high EvidenceMass",
    );
    assert.equal(gated.reason, "user_required_art_selection");
  });

  // ─── Regression 2 ────────────────────────────────────────────────────────────
  // MTG has deterministic artwork identity → auto-accepts even on a narrow
  // margin. The evidence expansion must not disturb this.
  test("MTG deterministic artwork remains auto accepted", () => {
    const candidates = [
      printing({ externalId: "a", game: "MTG", illustrationId: "art-a" }),
      printing({ externalId: "b", game: "MTG", illustrationId: "art-b" }),
    ];

    const decision: Decision = {
      ...acceptDecision(candidates[0], "art-group-vision"),
      candidates,
      artworkBoundary: assessArtworkBoundary("MTG"),
    };

    const gated = gateDecision(decision, false, { margin: 0.05, evidenceMass: 2 });

    assert.equal(gated.action, "accept", "MTG deterministic artwork should still auto-accept");
    assert.equal(gated.method, "art-group-vision");
  });

  // ─── Regression 3 ────────────────────────────────────────────────────────────
  // set-cn-verified (0.97) is the authoritative deterministic method and accepts
  // regardless of margin, artwork boundary, or evidence expansion.
  test("set-cn-verified remains authoritative", () => {
    const candidates = [
      printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
    ];

    const decision: Decision = {
      ...acceptDecision(candidates[0], "set-cn-verified"),
      artworkBoundary: assessArtworkBoundary("POKEMON"),
    };

    const gated = gateDecision(decision, false, { margin: 0.01, evidenceMass: 3 });

    assert.equal(gated.action, "accept", "set-cn-verified must auto-accept regardless of margin");
    assert.equal(gated.method, "set-cn-verified");
  });

  // Sanity: exactly at MARGIN_FLOOR the Pokémon gate still accepts (>= check),
  // so the regression suite pins both sides of the boundary.
  test("Pokemon at MARGIN_FLOOR still accepts (boundary intact)", () => {
    const candidates = [
      printing({ externalId: "a", game: "POKEMON", illustrationId: undefined }),
      printing({ externalId: "b", game: "POKEMON", illustrationId: undefined }),
    ];

    const decision: Decision = {
      ...acceptDecision(candidates[0], "art-group-vision"),
      candidates,
      artworkBoundary: assessArtworkBoundary("POKEMON"),
    };

    const gated = gateDecision(decision, false, { margin: MARGIN_FLOOR, evidenceMass: 5 });

    assert.equal(gated.action, "accept", "At MARGIN_FLOOR the Pokémon art gate accepts (>=)");
  });
});
