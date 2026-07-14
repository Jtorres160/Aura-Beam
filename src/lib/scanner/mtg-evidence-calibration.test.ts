// MTG EvidenceMass calibration fixtures (Phase 5.6, expanded in Phase 5.7).
//
// PURPOSE: observation, not tuning. This file does NOT change EVIDENCE_WEIGHTS,
// ranking, decision thresholds, or acceptance rules. It builds a small set of
// deterministic fixtures from REAL, pinned Magic: The Gathering data and records
// how the CURRENT evidence model classifies each signal, so that later weight
// calibration starts from observed behavior rather than intuition.
//
// Phase 5.7 expansion adds three signal-isolation cases and renders each through
// the calibration-report notebook helper:
//   Case 4 — artwork contradiction under full printing agreement (is artwork,
//            at weight 2.5, able to sink an otherwise printing-perfect match?).
//   Case 5 — a special treatment (borderless twin): same IDENTITY, different
//            PRINTING — recording that only collector number encodes it.
//   Case 6 — rarity isolated as the sole separator (how much should rarity, at
//            weight 0.5, matter?).
// NOTE ON CASE 4 REALISM: MTG collector numbers are unique within a set, so two
// real rows cannot share name+set+CN yet differ in artwork. The only HONEST way
// to reach that composition is a wrong `vision-compare` artwork reading against
// a real, printing-correct candidate — which is exactly the "AI is a sensor,
// not the judge" question. Case 4 is built that way; the candidate data is real.
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
import { formatCalibrationReport } from "@/lib/scanner/calibration-report";

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

/** Full calibration-report block for a fixture (Phase 5.7 notebook tooling). */
function report(args: {
  fixture: string;
  signals: EvidenceSignal[];
  humanExpectation: string;
  calibrationNote?: string;
}): void {
  console.log(
    "\n" +
      formatCalibrationReport({
        game: "MTG",
        fixture: args.fixture,
        signals: args.signals,
        humanExpectation: args.humanExpectation,
        calibrationNote: args.calibrationNote,
      }) +
      "\n",
  );
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

// ═══════════════════════════════════════════════════════════════════════════
//  Case 4 — Artwork contradiction under full printing agreement
// ═══════════════════════════════════════════════════════════════════════════
// The question: is artwork identity (weight 2.5) strong enough to, by itself,
// sink a candidate that is otherwise printing-PERFECT?
//
// Real MTG collector numbers are unique within a set, so no two real rows share
// name+set+CN yet differ in artwork. The only honest route to that composition
// is a WRONG vision reading: the OCR strip correctly reads M10 #146 common, but
// the `vision-compare` artwork sensor mis-groups the illustration and reports
// the Fahmi Fauzi id instead of Moeller's. The candidate (M10 #146) is entirely
// real; only the fallible vision reading is wrong — which is exactly the "AI is
// a sensor, not the judge" scenario this architecture exists to survive.

describe("MTG calibration — Case 4: artwork contradiction under full printing agreement", () => {
  const ev = evidence({
    name: "Lightning Bolt",
    setCode: "M10",
    collectorNumber: "146",
    rarity: "common",
    illustrationId: ART_FAUZI, // WRONG: vision mis-grouped Moeller art as Fauzi
  });

  const truePrinting = printing({ externalId: "m10-146" }); // real M10 #146 Moeller

  test("only the (wrong) vision artwork reading contradicts; every deterministic signal agrees", () => {
    const signals = assessIdentitySignals(ev, truePrinting);
    record("Case4 M10 #146 (correct card, bad vision art read)", signals);
    report({
      fixture: "Lightning Bolt M10 #146 — wrong vision artwork read",
      signals,
      humanExpectation:
        "Keep the printing-verified card. A lone contradicting vision guess must not override deterministic set+CN.",
      calibrationNote:
        "artwork (2.5) < name+set+CN combined (5.0), so full printing agreement dominates a single bad vision read.",
    });

    assert.equal(stateOf(signals, "name"), "match");
    assert.equal(stateOf(signals, "setCode"), "match");
    assert.equal(stateOf(signals, "collectorNumber"), "match");
    assert.equal(stateOf(signals, "rarity"), "match");
    assert.equal(
      stateOf(signals, "artwork"),
      "mismatch",
      "the wrong vision illustrationId surfaces as an artwork contradiction",
    );
  });

  test("a lone artwork contradiction cannot outweigh four agreeing printing signals", () => {
    // OBSERVATION (current weights, recorded — NOT a target): name+set+CN+rarity
    // (+5.5) minus artwork (−2.5) stays firmly positive, so the printing-verified
    // identity holds despite the bad vision read. This is the desired "sensor,
    // not judge" behavior; weight calibration will confirm the margin is right.
    const mass = calculateEvidenceMass(assessIdentitySignals(ev, truePrinting));
    assert.ok(
      mass > 0,
      `full printing agreement must survive one contradicting vision read (mass ${mass})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 5 — Special treatment: same identity, different printing
// ═══════════════════════════════════════════════════════════════════════════
// Collectors care about treatments (borderless / showcase / extended / promo) as
// distinct COLLECTIBLES, but they are the same card IDENTITY. Using the real SOS
// borderless twin (#332, Branwyn art) against a scan of the regular #113, observe
// how the current model encodes a treatment: every identity signal (name, set,
// rarity, artwork) matches, and ONLY the collector number separates them. The
// candidate carries borderColor/frame/promoTypes, but assessIdentitySignals has
// NO treatment signal — so today a treatment is visible to EvidenceMass solely
// through its collector number. (Case 3 read this pair as false-positive
// resistance; here the lens is the missing treatment signal.)

describe("MTG calibration — Case 5: special treatment shares identity, differs only by printing", () => {
  const DFC_NAME = "Emeritus of Conflict // Lightning Bolt";

  const ev = evidence({
    name: "Lightning Bolt",
    setCode: "SOS",
    collectorNumber: "113",
    rarity: "mythic",
    illustrationId: ART_BRANWYN,
  });

  // Real borderless variant (#332). borderColor is carried on the candidate but
  // is deliberately UNUSED by the evidence model today — that is the observation.
  const borderless = printing({
    externalId: "sos-332",
    name: DFC_NAME,
    setName: "Secrets of Strixhaven",
    setCode: "SOS",
    collectorNumber: "332",
    rarity: "mythic",
    illustrationId: ART_BRANWYN,
    borderColor: "borderless",
  });

  test("identity signals all agree; collector number is the ONLY separator", () => {
    const signals = assessIdentitySignals(ev, borderless);
    record("Case5 SOS #332 (borderless treatment)", signals);
    report({
      fixture: "Lightning Bolt SOS #332 — borderless treatment of scanned #113",
      signals,
      humanExpectation:
        "Same card identity, different collectible printing — offer the borderless as a distinct printing, not a different card.",
      calibrationNote:
        "borderColor/frame/promoTypes are carried on the candidate but unscored; only collectorNumber encodes the treatment today.",
    });

    assert.equal(stateOf(signals, "name"), "match");
    assert.equal(stateOf(signals, "setCode"), "match");
    assert.equal(stateOf(signals, "rarity"), "match");
    assert.equal(stateOf(signals, "artwork"), "match", "borderless shares the illustration → artwork matches");
    assert.equal(stateOf(signals, "collectorNumber"), "mismatch");
  });

  test("the evidence model exposes no dedicated treatment signal", () => {
    const signals = assessIdentitySignals(ev, borderless);
    const types = signals.map((s) => s.type);
    // The treatment is real (borderColor === "borderless") but invisible to the
    // signal set — a concrete input for whether calibration should add one.
    assert.ok(!types.includes("borderColor" as never), "no borderColor signal exists yet");
    assert.ok(!types.includes("frame" as never), "no frame signal exists yet");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 6 — Rarity isolated as the sole separator
// ═══════════════════════════════════════════════════════════════════════════
// How much should rarity (weight 0.5) matter? The Moeller Lightning Bolt is a
// common in M10 (#146) and an uncommon in A25 (#141) — SAME illustration. To
// isolate rarity, the scan reads name + rarity + artwork but NOT set/CN (a
// realistic strip-OCR miss). Then the two real reprints agree on name and
// artwork and are separated ONLY by rarity, so the mass gap equals exactly the
// rarity swing (a match vs a mismatch = 2 × 0.5 = 1.0). This records how thin
// rarity's influence is when it stands alone.

describe("MTG calibration — Case 6: rarity as the sole separator", () => {
  const ev = evidence({
    name: "Lightning Bolt",
    rarity: "common", // scanned card is the M10 common; set/CN unread → unknown
    illustrationId: ART_MOELLER,
  });

  const commonM10 = printing({ externalId: "m10-146" }); // common, Moeller
  const uncommonA25 = printing({
    externalId: "a25-141",
    setName: "Masters 25",
    setCode: "A25",
    collectorNumber: "141",
    rarity: "uncommon", // same Moeller illustration, different rarity
    illustrationId: ART_MOELLER,
  });

  test("name + artwork match both; rarity alone distinguishes them", () => {
    const sCommon = assessIdentitySignals(ev, commonM10);
    const sUncommon = assessIdentitySignals(ev, uncommonA25);
    record("Case6 M10 #146 (rarity match)", sCommon);
    record("Case6 A25 #141 (rarity mismatch)", sUncommon);
    report({
      fixture: "Lightning Bolt — M10 common vs A25 uncommon (set/CN unread)",
      signals: sUncommon,
      humanExpectation:
        "Prefer the rarity that matches, but weakly — with set/CN unread, rarity is the only evidence in play.",
      calibrationNote:
        "rarity=0.5 is a deliberately weak separator; when it stands alone the mass gap is just 1.0.",
    });

    // Both share name + artwork; set/CN are unknown on both (unread).
    assert.equal(stateOf(sCommon, "name"), "match");
    assert.equal(stateOf(sUncommon, "name"), "match");
    assert.equal(stateOf(sCommon, "artwork"), "match");
    assert.equal(stateOf(sUncommon, "artwork"), "match");
    assert.equal(stateOf(sCommon, "setCode"), "unknown");
    assert.equal(stateOf(sUncommon, "setCode"), "unknown");
    assert.equal(stateOf(sCommon, "collectorNumber"), "unknown");
    assert.equal(stateOf(sUncommon, "collectorNumber"), "unknown");

    // Rarity is the only differing signal.
    assert.equal(stateOf(sCommon, "rarity"), "match");
    assert.equal(stateOf(sUncommon, "rarity"), "mismatch");
  });

  test("the rarity-matching reprint out-masses the other by exactly the rarity swing", () => {
    const massMatch = calculateEvidenceMass(assessIdentitySignals(ev, commonM10));
    const massMismatch = calculateEvidenceMass(assessIdentitySignals(ev, uncommonA25));

    assert.ok(massMatch > massMismatch, `rarity-match (${massMatch}) should out-mass rarity-mismatch (${massMismatch})`);

    // OBSERVATION (current weight, recorded — NOT a target): the gap is exactly
    // 2 × rarity weight = 1.0. If real scans show rarity should decide harder or
    // softer, this is the number calibration will move.
    assert.equal(
      massMatch - massMismatch,
      2 * 0.5,
      "isolated rarity produces a mass gap of exactly twice its weight",
    );
  });
});
