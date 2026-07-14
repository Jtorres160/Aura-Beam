// MTG EvidenceMass calibration fixtures (Phase 5.6).
//
// PURPOSE: observation, not tuning. This file does NOT change EVIDENCE_WEIGHTS,
// ranking, decision thresholds, or acceptance rules. It builds a small set of
// deterministic fixtures from REAL, pinned Magic: The Gathering data and records
// how the CURRENT evidence model classifies each signal, so that later weight
// calibration starts from observed behavior rather than intuition.
//
// Assertions here verify OBSERVATIONS about the signal composition (which fields
// match / mismatch / stay unknown, and their relative ordering) — never final
// decisions and never a hard-coded EvidenceMass total. Each case also prints its
// signal composition so the calibration record is human-reviewable.
//
// ─── Pinned real data (Scryfall, unique=prints; fetched 2026-07-13) ──────────
// Lightning Bolt — Christopher Moeller illustration
//   illustration_id 013e7eda-ef8e-44cd-9832-4033d9de1c34, shared by:
//     M10  #146  common     (Magic 2010)
//     A25  #141  uncommon   (Masters 25)
//     2X2  #117  uncommon   (Double Masters 2022)
// Lightning Bolt — Fahmi Fauzi illustration (single-faced alternate art)
//   illustration_id d6a96e90-165e-4c31-bb4f-9ca665e4b437
//     PW26 #5    rare       (Wizards Play Network 2026)
// Emeritus of Conflict // Lightning Bolt — Alix Branwyn illustration
//   illustration_id 6967d2f3-9cd9-44fd-8843-c3a4eead6c52, shared by:
//     SOS  #113  mythic     (Secrets of Strixhaven, regular)
//     SOS  #332  mythic     (Secrets of Strixhaven, borderless variant)
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/mtg-evidence-calibration.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assessIdentitySignals,
  calculateEvidenceMass,
  reading,
  type CandidatePrinting,
  type EvidenceSignal,
  type EvidenceSignalType,
  type ScanEvidence,
} from "@/lib/scanner/evidence";

// ─── Pinned illustration identities ──────────────────────────────────────────

const ART_MOELLER = "013e7eda-ef8e-44cd-9832-4033d9de1c34";
const ART_FAUZI = "d6a96e90-165e-4c31-bb4f-9ca665e4b437";
const ART_BRANWYN = "6967d2f3-9cd9-44fd-8843-c3a4eead6c52";

// ─── Fixture builders ────────────────────────────────────────────────────────

/** A real MTG printing, all fields defaulting to the Moeller M10 Lightning Bolt.
 *  Every default below is a genuine Scryfall value — nothing invented. */
function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Lightning Bolt",
    game: "MTG",
    setName: "Magic 2010",
    setCode: "M10",
    collectorNumber: "146",
    rarity: "common",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    illustrationId: ART_MOELLER,
    ...over,
  };
}

/** The OCR/vision readings off ONE scanned card. Only the fields passed were
 *  "read"; everything else is genuinely unobserved (undefined → unknown). */
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

/** State of one named signal in an assessment (for observation asserts). */
function stateOf(signals: EvidenceSignal[], type: EvidenceSignalType) {
  return signals.find((s) => s.type === type)?.state;
}

/** Compact, reviewable rendering of a signal set + its mass, for the record. */
function record(label: string, signals: EvidenceSignal[]): void {
  const composition = signals.map((s) => `${s.type}:${s.state}`).join(", ");
  const mass = calculateEvidenceMass(signals);
  // Mirrors the existing "[Scanner] EvidenceMass …" telemetry line style.
  console.log(`[Calibration] ${label} — mass ${mass} — ${composition}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Case 1 — Same card, same artwork, different printing
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Moeller-art Lightning Bolt read as M10 #146.
// Candidates M10 #146 and 2X2 #117 are the SAME card with the SAME illustration
// but are different printings. Observe that identity evidence (name + artwork)
// agrees for BOTH, while printing-level fields (set / collector number / rarity)
// are what separate them.

describe("MTG calibration — Case 1: same card, same artwork, different printing", () => {
  const ev = evidence({
    name: "Lightning Bolt",
    setCode: "M10",
    collectorNumber: "146",
    rarity: "common",
    illustrationId: ART_MOELLER,
  });

  const m10 = printing({ externalId: "m10-146" }); // exact printing scanned
  const dbl = printing({
    externalId: "2x2-117",
    setName: "Double Masters 2022",
    setCode: "2X2",
    collectorNumber: "117",
    rarity: "uncommon",
    illustrationId: ART_MOELLER, // SAME illustration as M10
  });

  test("identity signals (name + artwork) agree for both printings", () => {
    const sM10 = assessIdentitySignals(ev, m10);
    const sDbl = assessIdentitySignals(ev, dbl);
    record("Case1 M10 #146 (scanned printing)", sM10);
    record("Case1 2X2 #117 (same art, other printing)", sDbl);

    // Strong identity agreement holds across the printing boundary.
    assert.equal(stateOf(sM10, "name"), "match");
    assert.equal(stateOf(sDbl, "name"), "match");
    assert.equal(stateOf(sM10, "artwork"), "match");
    assert.equal(stateOf(sDbl, "artwork"), "match", "shared illustration_id → artwork matches on the reprint too");
  });

  test("printing-level fields separate the two printings", () => {
    const sDbl = assessIdentitySignals(ev, dbl);
    // Same card, different printing → set / CN / rarity contradict.
    assert.equal(stateOf(sDbl, "setCode"), "mismatch");
    assert.equal(stateOf(sDbl, "collectorNumber"), "mismatch");
    assert.equal(stateOf(sDbl, "rarity"), "mismatch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 2 — Same card name, alternate artwork
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Moeller-art Lightning Bolt read as M10 #146.
// Candidate A is that exact printing (artwork matches); candidate B is the
// Fahmi Fauzi alternate-art Lightning Bolt (PW26 #5). Observe that the name
// matches BOTH, but artwork identity distinguishes them as separate identities.

describe("MTG calibration — Case 2: same card name, alternate artwork", () => {
  const ev = evidence({
    name: "Lightning Bolt",
    setCode: "M10",
    collectorNumber: "146",
    illustrationId: ART_MOELLER,
  });

  const sameArt = printing({ externalId: "m10-146" });
  const altArt = printing({
    externalId: "pw26-5",
    setName: "Wizards Play Network 2026",
    setCode: "PW26",
    collectorNumber: "5",
    rarity: "rare",
    illustrationId: ART_FAUZI, // genuinely different illustration
  });

  test("name matches both, artwork identity distinguishes them", () => {
    const sSame = assessIdentitySignals(ev, sameArt);
    const sAlt = assessIdentitySignals(ev, altArt);
    record("Case2 M10 #146 (matching art)", sSame);
    record("Case2 PW26 #5 (alternate art)", sAlt);

    assert.equal(stateOf(sSame, "name"), "match");
    assert.equal(stateOf(sAlt, "name"), "match", "name agrees even across different artwork");

    assert.equal(stateOf(sSame, "artwork"), "match");
    assert.equal(
      stateOf(sAlt, "artwork"),
      "mismatch",
      "different illustration_id → artwork mismatch marks a separate identity",
    );
  });

  test("the alternate-art candidate carries a visible artwork contradiction", () => {
    // Observation only: with a name match but an artwork contradiction, the
    // matching-art candidate should out-mass the alternate-art one. This is a
    // relative ordering, not a target total.
    const massSame = calculateEvidenceMass(assessIdentitySignals(ev, sameArt));
    const massAlt = calculateEvidenceMass(assessIdentitySignals(ev, altArt));
    assert.ok(
      massSame > massAlt,
      `Matching-art printing (${massSame}) should out-mass alternate-art (${massAlt})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 3 — Same set, wrong collector number (false-positive resistance)
// ═══════════════════════════════════════════════════════════════════════════
// The hardest false positive: two printings of the SAME card in the SAME set,
// sharing name, set, illustration and rarity — differing ONLY in collector
// number. Scan reads SOS #113; the borderless SOS #332 is the near-twin.
// Observe that the collector-number contradiction is the sole visible signal
// that separates them, and record how much positive mass the wrong-CN twin
// still retains under current weights (a calibration data point).

describe("MTG calibration — Case 3: same set, wrong collector number", () => {
  const DFC_NAME = "Emeritus of Conflict // Lightning Bolt"; // real SOS #113/#332 name

  const ev = evidence({
    name: "Lightning Bolt", // OCR reads the back face; nameMatchesOcr splits on "//"
    setCode: "SOS",
    collectorNumber: "113",
    rarity: "mythic",
    illustrationId: ART_BRANWYN,
  });

  const correct = printing({
    externalId: "sos-113",
    name: DFC_NAME,
    setName: "Secrets of Strixhaven",
    setCode: "SOS",
    collectorNumber: "113",
    rarity: "mythic",
    illustrationId: ART_BRANWYN,
  });
  const wrongCn = printing({
    externalId: "sos-332",
    name: DFC_NAME,
    setName: "Secrets of Strixhaven",
    setCode: "SOS",
    collectorNumber: "332", // borderless variant — the only differing field
    rarity: "mythic",
    illustrationId: ART_BRANWYN,
  });

  test("only the collector number contradicts; every other signal agrees", () => {
    const sWrong = assessIdentitySignals(ev, wrongCn);
    record("Case3 SOS #113 (correct)", assessIdentitySignals(ev, correct));
    record("Case3 SOS #332 (wrong CN twin)", sWrong);

    assert.equal(stateOf(sWrong, "name"), "match");
    assert.equal(stateOf(sWrong, "setCode"), "match");
    assert.equal(stateOf(sWrong, "rarity"), "match");
    assert.equal(stateOf(sWrong, "artwork"), "match");
    assert.equal(
      stateOf(sWrong, "collectorNumber"),
      "mismatch",
      "wrong collector number must surface as a visible contradiction",
    );
  });

  test("collector-number contradiction lowers mass but does not, alone, go negative", () => {
    const massCorrect = calculateEvidenceMass(assessIdentitySignals(ev, correct));
    const massWrong = calculateEvidenceMass(assessIdentitySignals(ev, wrongCn));

    // Correct printing out-masses the wrong-CN twin (weight-robust ordering).
    assert.ok(massCorrect > massWrong, `correct (${massCorrect}) must out-mass wrong-CN (${massWrong})`);

    // OBSERVATION (current-weight behavior, recorded for calibration — NOT a
    // target): four agreeing signals outweigh one collector-number contradiction,
    // so the wrong-CN twin still holds net-positive mass. This is precisely the
    // kind of behavior weight calibration will later interrogate.
    assert.ok(
      massWrong > 0,
      `under current weights the wrong-CN twin retains positive mass (${massWrong})`,
    );
  });
});
