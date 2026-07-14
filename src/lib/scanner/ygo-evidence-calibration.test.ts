// Yu-Gi-Oh! EvidenceMass calibration fixtures (Phase 5.9).
//
// PURPOSE: observation, not tuning. Like the MTG (Phase 5.6/5.7) and Pokémon
// (Phase 5.8) calibration files, this does NOT change EVIDENCE_WEIGHTS, ranking,
// decision thresholds, or acceptance rules. It builds deterministic fixtures from
// REAL, pinned YGOPRODeck data and records how the CURRENT evidence model
// classifies each signal — completing the cross-game evidence map before any
// calibration decisions are made.
//
// THE YU-GI-OH CONSTRAINT, made concrete (and it is the MIRROR IMAGE of Pokémon):
//   • formatYugiohCard() and the primary art-variant path in candidates.ts
//     (fetchYugiohPrintings) populate name, setCode and rarity — but NEVER
//     `collectorNumber`. A Yu-Gi-Oh printing IS identified by its set code
//     ("LOB-EN001"), which already embeds the number; there is no separate
//     collector-number field on the data source. So for EVERY real Yu-Gi-Oh
//     candidate, compareCollectorNumber() sees no candidate collectorNumber and
//     returns `unknown`. It is not "sometimes missing"; it is ALWAYS unknown.
//     This is the trust guarantee under test: unknown must never become mismatch,
//     or every Yu-Gi-Oh scan would carry a phantom −2.0 collectorNumber penalty.
//   • Yu-Gi-Oh DOES supply deterministic artwork identity — each entry in
//     card_images[] carries its own id, surfaced as `illustrationId` on the
//     candidate (see getYugiohPrintings). So compareArtwork() is LIVE for
//     Yu-Gi-Oh, unlike Pokémon where it is structurally unknown. The two games
//     are complementary: Pokémon has collector number but no artwork identity;
//     Yu-Gi-Oh has artwork identity but no collector number.
//   • Yu-Gi-Oh rarity spellings ("Ultra Rare", "Super Rare", "Secret Rare"…) are
//     NOT in normalizeRarity's table, so compareRarity returns `unknown` for
//     them — only "Common" and "Rare" map. Recorded as a calibration observation,
//     not fixed: rarity is largely silent for Yu-Gi-Oh today, as it is for Pokémon.
//
// Net: a Yu-Gi-Oh scan leans on name + setCode + artwork, with collectorNumber
// and (usually) rarity silent. Cases 1–4 observe whether that is coherent.
//
// Assertions verify OBSERVATIONS about signal composition (match / mismatch /
// unknown and relative ordering) — never final decisions and never a hard-coded
// EvidenceMass total. Each case also renders its composition for human review.
//
// ─── Pinned real data (db.ygoprodeck.com v7; fetched 2026-07-13) ─────────────
// Blue-Eyes White Dragon — passcode/card id 89631139
//   card_images ids: 89631139 (original art), 89631140 (alternate art)  [both real]
//   card_sets:
//     LOB-EN001   Legend of Blue Eyes White Dragon   Ultra Rare
//     SKE-001     Starter Deck: Kaiba Evolution       Super Rare   (same card + art)
//     SDKS-EN009  Structure Deck: Seto Kaiba          Common       (MAPPABLE rarity)
// Dark Magician — card id 46986414, original art id 46986414
//     LOB-EN005   Legend of Blue Eyes White Dragon   Ultra Rare
// Dark Magician Girl — card id 38033121, original art id 38033121
//     a genuinely DIFFERENT real card whose name is a prefix-collision with
//     "Dark Magician" — the honest name-collision probe for Case 3.
// NOTE: none of these candidates carry a collectorNumber — the Yu-Gi-Oh source
// provides none, and candidates.ts mirrors that. That absence is the subject of
// Case 4.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/ygo-evidence-calibration.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assessIdentitySignals,
  calculateEvidenceMass,
  reading,
  EVIDENCE_WEIGHTS,
  type CandidatePrinting,
  type EvidenceSignal,
  type EvidenceSignalType,
  type ScanEvidence,
} from "@/lib/scanner/evidence";
import { formatCalibrationReport, signalContribution } from "@/lib/scanner/calibration-report";

// ─── Pinned artwork identities (card_images[].id) ────────────────────────────

const ART_BEWD = "89631139"; // Blue-Eyes White Dragon, original art
const ART_BEWD_ALT = "89631140"; // Blue-Eyes White Dragon, alternate art
const ART_DM = "46986414"; // Dark Magician, original art
const ART_DMG = "38033121"; // Dark Magician Girl, original art

// ─── Fixture builders ────────────────────────────────────────────────────────

/** A real Yu-Gi-Oh printing, all fields defaulting to the LOB-EN001 Blue-Eyes
 *  White Dragon. Every default is a genuine YGOPRODeck value — nothing invented.
 *  Crucially, collectorNumber is OMITTED, exactly as formatYugiohCard/candidates
 *  leave it: the data source provides no separate collector number (the set code
 *  embeds it), so it must stay absent (→ unknown), never fabricated. */
function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Blue-Eyes White Dragon",
    game: "YUGIOH",
    setName: "Legend of Blue Eyes White Dragon",
    setCode: "LOB-EN001", // the Yu-Gi-Oh printing key — number is embedded here
    rarity: "Ultra Rare",
    imageUrl: "https://example/img.jpg",
    thumbnailUrl: "https://example/thumb.jpg",
    price: { marketPrice: 0 },
    illustrationId: ART_BEWD, // Yu-Gi-Oh DOES supply artwork identity
    // collectorNumber deliberately absent — the Yu-Gi-Oh source cannot provide it.
    ...over,
  };
}

/** The OCR/vision readings off ONE scanned card. Only the fields passed were
 *  "read"; everything else is genuinely unobserved (undefined → unknown). The
 *  collectorNumber field exists for parity with MTG/Pokémon, but real Yu-Gi-Oh
 *  candidates never carry one to compare against — so it stays unknown regardless. */
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
        game: "YUGIOH",
        fixture: args.fixture,
        signals: args.signals,
        humanExpectation: args.humanExpectation,
        calibrationNote: args.calibrationNote,
      }) +
      "\n",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Case 1 — Same card, different rarity printing
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Blue-Eyes White Dragon read as LOB-EN001, Ultra Rare, original art.
// Candidate A is that exact printing; candidate B is the SAME card, SAME original
// artwork, in a DIFFERENT set at a DIFFERENT rarity (SKE-001, Super Rare). Observe
// how rarity behaves: because both "Ultra Rare" and "Super Rare" are unmapped,
// compareRarity stands down to unknown on BOTH — so a genuinely different rarity
// is NOT recorded as a mismatch. The set code separates the two printings while
// artwork confirms it is the same card across them.
//
// Question: does rarity act as SUPPORTING evidence rather than identity proof?
// Observation: for Yu-Gi-Oh, rarity is effectively silent (unmapped → unknown);
// it neither proves nor separates identity today. The printing is separated by
// setCode; the card is confirmed by artwork.

describe("YUGIOH calibration — Case 1: same card, different rarity printing", () => {
  const ev = evidence({
    name: "Blue-Eyes White Dragon",
    setCode: "LOB-EN001",
    rarity: "Ultra Rare",
    illustrationId: ART_BEWD,
    // no collectorNumber: Yu-Gi-Oh candidates never carry one anyway
  });

  const lob = printing({ externalId: "89631139" }); // exact printing scanned
  const ske = printing({
    externalId: "89631139-ske",
    setName: "Starter Deck: Kaiba Evolution",
    setCode: "SKE-001",
    rarity: "Super Rare", // genuinely different rarity — but unmapped → unknown
    illustrationId: ART_BEWD, // SAME original artwork
  });

  test("name + artwork agree for both; set code separates the printings", () => {
    const sLob = assessIdentitySignals(ev, lob);
    const sSke = assessIdentitySignals(ev, ske);
    record("Case1 LOB-EN001 Ultra Rare (scanned printing)", sLob);
    record("Case1 SKE-001 Super Rare (same card + art, other set)", sSke);

    // Same card, same illustration → identity signals agree across the printings.
    assert.equal(stateOf(sLob, "name"), "match");
    assert.equal(stateOf(sSke, "name"), "match", "same card name across sets");
    assert.equal(stateOf(sLob, "artwork"), "match");
    assert.equal(stateOf(sSke, "artwork"), "match", "shared original art id → artwork matches too");

    // The set code is the field that distinguishes the two printings.
    assert.equal(stateOf(sSke, "setCode"), "mismatch");
  });

  test("rarity is supporting-only: a real rarity difference reads as unknown, not mismatch", () => {
    const sSke = assessIdentitySignals(ev, ske);
    report({
      fixture: "Blue-Eyes White Dragon SKE-001 Super Rare — different-rarity printing of scanned LOB-EN001",
      signals: sSke,
      humanExpectation:
        "Same card, a different set/rarity printing — separate it by set code, and do not let the rarity difference read as a contradiction.",
      calibrationNote:
        "rarity is unmapped for Yu-Gi-Oh (Ultra Rare vs Super Rare → unknown), so a real rarity difference does not register at all; collectorNumber is structurally unknown; setCode alone separates the printings while artwork confirms the shared card.",
    });

    // OBSERVATION: the rarities genuinely differ, but neither spelling maps, so
    // compareRarity stands down to unknown — rarity never becomes a contradiction.
    assert.equal(stateOf(sSke, "rarity"), "unknown");
    // OBSERVATION: collectorNumber is structurally absent on Yu-Gi-Oh candidates.
    assert.equal(stateOf(sSke, "collectorNumber"), "unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 2 — Same card id, different print / treatment (artwork separation)
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Blue-Eyes White Dragon matched to the ORIGINAL art group (id 89631139).
// Candidate A is that original-art printing; candidate B is the SAME card id in a
// different collectible treatment — the ALTERNATE artwork (card_images id
// 89631140). Set code and rarity are held constant to ISOLATE artwork as the sole
// separator (Yu-Gi-Oh's set/art association from getYugiohPrintings is best-effort
// by index, so the honest test of the artwork comparator holds the rest fixed).
//
// Question: which signal distinguishes collectible variants — and are we missing a
// future signal (edition / printing type / treatment)? Observation: UNLIKE Pokémon,
// Yu-Gi-Oh HAS deterministic artwork identity, so alternate-art treatments ARE
// separable today via the artwork signal. The still-missing structured signal for
// Yu-Gi-Oh is collectorNumber, not artwork.

describe("YUGIOH calibration — Case 2: same card id, alternate-art treatment", () => {
  const ev = evidence({
    name: "Blue-Eyes White Dragon",
    setCode: "LOB-EN001",
    rarity: "Ultra Rare",
    illustrationId: ART_BEWD, // vision matched the ORIGINAL art group
  });

  const originalArt = printing({ externalId: "89631139" }); // original art
  const alternateArt = printing({
    externalId: "89631139:89631140", // qualifyId shape for a multi-art card
    illustrationId: ART_BEWD_ALT, // genuinely different card_images id
  });

  test("name + set match both; artwork identity distinguishes the treatments", () => {
    const sOriginal = assessIdentitySignals(ev, originalArt);
    const sAlternate = assessIdentitySignals(ev, alternateArt);
    record("Case2 art 89631139 (original, scanned)", sOriginal);
    record("Case2 art 89631140 (alternate-art treatment)", sAlternate);
    report({
      fixture: "Blue-Eyes White Dragon — original art (89631139) vs alternate art (89631140)",
      signals: sAlternate,
      humanExpectation:
        "Same card, a different art treatment — offer the alternate art as a distinct printing, separated by artwork identity.",
      calibrationNote:
        "Yu-Gi-Oh supplies deterministic artwork identity (card_images[].id), so the artwork signal (2.5) is what separates alternate-art treatments — the future-signal gap for Yu-Gi-Oh is collectorNumber, not artwork.",
    });

    assert.equal(stateOf(sAlternate, "name"), "match");
    assert.equal(stateOf(sAlternate, "setCode"), "match");
    assert.equal(stateOf(sOriginal, "artwork"), "match");
    assert.equal(
      stateOf(sAlternate, "artwork"),
      "mismatch",
      "different card_images id → artwork mismatch marks the alternate treatment",
    );
  });

  test("the matching-art treatment out-masses the alternate-art one (artwork is the separator)", () => {
    // Observation only: with name + set matching both, the original-art candidate
    // should out-mass the alternate-art one by the artwork swing. Relative
    // ordering, not a target total.
    const massOriginal = calculateEvidenceMass(assessIdentitySignals(ev, originalArt));
    const massAlternate = calculateEvidenceMass(assessIdentitySignals(ev, alternateArt));
    assert.ok(
      massOriginal > massAlternate,
      `original-art (${massOriginal}) should out-mass alternate-art (${massAlternate})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 3 — Same/similar name, different cards (name-collision resistance)
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Dark Magician read as its own card (LOB-EN005, art 46986414). Candidate B
// is a genuinely DIFFERENT real card whose name is a prefix-collision: "Dark
// Magician Girl" (id/art 38033121). Observe that Aura does not over-trust name
// similarity — nameMatchesOcr rejects the longer name (length gap > 2 defeats the
// fuzzy tolerance), and artwork + set independently contradict.
//
// NOTE on realism: Konami enforces unique English card names, so a genuine
// "same exact name, different card id" pair does not exist in Yu-Gi-Oh — which is
// itself a calibration input: a name match is STRONGER identity evidence in
// Yu-Gi-Oh than in a game with name collisions. The honest probe here is the
// nearest real collision — a shared name PREFIX — and the test confirms the fuzzy
// matcher still separates the two distinct cards.

describe("YUGIOH calibration — Case 3: similar name, different cards", () => {
  const ev = evidence({
    name: "Dark Magician",
    setCode: "LOB-EN005",
    rarity: "Ultra Rare",
    illustrationId: ART_DM,
  });

  const darkMagician = printing({
    externalId: "46986414",
    name: "Dark Magician",
    setName: "Legend of Blue Eyes White Dragon",
    setCode: "LOB-EN005",
    rarity: "Ultra Rare",
    illustrationId: ART_DM,
  });
  const darkMagicianGirl = printing({
    externalId: "38033121",
    name: "Dark Magician Girl", // genuinely different card, colliding name prefix
    setName: "2-Player Starter Set",
    setCode: "STAX-EN020",
    rarity: "Common",
    illustrationId: ART_DMG,
  });

  test("the correct card matches; the similar-named different card is rejected on name", () => {
    const sCorrect = assessIdentitySignals(ev, darkMagician);
    const sDecoy = assessIdentitySignals(ev, darkMagicianGirl);
    record("Case3 Dark Magician (correct)", sCorrect);
    record("Case3 Dark Magician Girl (similar name, different card)", sDecoy);

    assert.equal(stateOf(sCorrect, "name"), "match");
    assert.equal(
      stateOf(sDecoy, "name"),
      "mismatch",
      "the name-prefix collision does not fuzzy-match a longer, distinct card name",
    );
  });

  test("set code and artwork independently separate the two distinct cards", () => {
    const sDecoy = assessIdentitySignals(ev, darkMagicianGirl);
    // Two independent contradictions back up the name rejection.
    assert.equal(stateOf(sDecoy, "setCode"), "mismatch");
    assert.equal(stateOf(sDecoy, "artwork"), "mismatch");

    // OBSERVATION: the correct card out-masses the similar-named decoy decisively —
    // Aura does not over-trust name similarity. Relative ordering, not a target.
    const massCorrect = calculateEvidenceMass(assessIdentitySignals(ev, darkMagician));
    const massDecoy = calculateEvidenceMass(assessIdentitySignals(ev, darkMagicianGirl));
    assert.ok(
      massCorrect > massDecoy,
      `correct Dark Magician (${massCorrect}) must out-mass the similar-named decoy (${massDecoy})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 4 — Unknown evidence behavior (collectorNumber unknown stays neutral)
// ═══════════════════════════════════════════════════════════════════════════
// The Yu-Gi-Oh trust guarantee, tested arithmetically — the mirror of Pokémon's
// unknown-artwork case. For EVERY real Yu-Gi-Oh candidate, collectorNumber is
// structurally absent (the set code embeds the number), so compareCollectorNumber
// returns unknown. Even if OCR read a number off the card, there is nothing to
// compare it against. We confirm:
//   • unknown collectorNumber contributes exactly 0 to EvidenceMass,
//   • a mismatch WOULD subtract EVIDENCE_WEIGHTS.collectorNumber (2.0),
//   • so the unknown mass equals the mass with collectorNumber removed entirely.
// We also record the Yu-Gi-Oh "happy path": using SDKS-EN009 (Common — a MAPPABLE
// rarity), name + set + rarity + artwork all match while collectorNumber stays
// unknown, yielding strong positive mass with no collectorNumber term.

describe("YUGIOH calibration — Case 4: unknown collectorNumber stays neutral", () => {
  // Even though OCR "read" a collector number, the candidate carries none →
  // compareCollectorNumber must resolve to unknown, never a mismatch.
  const ev = evidence({
    name: "Blue-Eyes White Dragon",
    setCode: "SDKS-EN009",
    collectorNumber: "9", // OCR guess; no candidate field exists to compare it to
    rarity: "Common", // MAPPABLE rarity → a real rarity match is possible
    illustrationId: ART_BEWD,
  });

  const structureDeck = printing({
    externalId: "89631139-sdks",
    setName: "Structure Deck: Seto Kaiba",
    setCode: "SDKS-EN009",
    rarity: "Common",
    illustrationId: ART_BEWD,
    // still no collectorNumber — Yu-Gi-Oh candidates never carry one
  });

  test("collectorNumber resolves to unknown despite an OCR read, and contributes 0", () => {
    const signals = assessIdentitySignals(ev, structureDeck);
    record("Case4 SDKS-EN009 Common (collectorNumber unknown)", signals);

    const cn = signals.find((s) => s.type === "collectorNumber")!;
    assert.equal(cn.state, "unknown", "no candidate collectorNumber → unknown, not mismatch");
    assert.equal(signalContribution(cn), 0, "unknown collectorNumber contributes exactly 0 mass");
  });

  test("unknown does not subtract: unknown mass == mass-without-CN, and > a mismatch", () => {
    const signals = assessIdentitySignals(ev, structureDeck);
    const massUnknown = calculateEvidenceMass(signals);

    // Mass with the collectorNumber signal removed entirely — the neutral baseline.
    const massWithoutCn = calculateEvidenceMass(signals.filter((s) => s.type !== "collectorNumber"));

    // The same signal set with collectorNumber flipped to a mismatch (observation
    // of the aggregation rule only — no invented candidate data).
    const asMismatch = signals.map((s) =>
      s.type === "collectorNumber" ? ({ ...s, state: "mismatch" as const }) : s,
    );
    const massMismatch = calculateEvidenceMass(asMismatch);

    assert.equal(massUnknown, massWithoutCn, "unknown collectorNumber leaves mass unchanged");
    assert.equal(
      massUnknown - massMismatch,
      EVIDENCE_WEIGHTS.collectorNumber,
      "the unknown→mismatch gap is exactly the collectorNumber weight — this is the guarantee",
    );
    assert.ok(massUnknown > massMismatch, "unknown must never be treated as a contradiction");
  });

  test("Yu-Gi-Oh happy path: name + set + rarity + artwork match; strong positive mass, no CN term", () => {
    const signals = assessIdentitySignals(ev, structureDeck);
    report({
      fixture: "Blue-Eyes White Dragon SDKS-EN009 Common — full available agreement, collectorNumber unavailable",
      signals,
      humanExpectation:
        "Confirm the card confidently from name + set + rarity + artwork, even though Yu-Gi-Oh supplies no collector number.",
      calibrationNote:
        "artwork (2.5) IS available for Yu-Gi-Oh, so a fully-agreeing scan reaches name+set+rarity+artwork = 6.0; collectorNumber stays unknown (0). Contrast: Pokémon has CN but no artwork; Yu-Gi-Oh has artwork but no CN. Records whether 6.0 is 'strong enough' for a Yu-Gi-Oh accept.",
    });

    assert.equal(stateOf(signals, "name"), "match");
    assert.equal(stateOf(signals, "setCode"), "match");
    assert.equal(stateOf(signals, "rarity"), "match", "Common IS in normalizeRarity");
    assert.equal(stateOf(signals, "artwork"), "match", "Yu-Gi-Oh artwork identity is available");
    assert.equal(stateOf(signals, "collectorNumber"), "unknown", "no source collector number");

    const mass = calculateEvidenceMass(signals);
    const massWithoutCn = calculateEvidenceMass(signals.filter((s) => s.type !== "collectorNumber"));
    assert.equal(mass, massWithoutCn, "collectorNumber contributes nothing to a Yu-Gi-Oh match");
    assert.ok(mass > 0, `four agreeing available signals give strong positive mass (${mass})`);
  });
});
