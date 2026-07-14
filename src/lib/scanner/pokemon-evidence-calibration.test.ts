// Pokémon EvidenceMass calibration fixtures (Phase 5.8).
//
// PURPOSE: observation, not tuning. Like the MTG calibration file, this does NOT
// change EVIDENCE_WEIGHTS, ranking, decision thresholds, or acceptance rules. It
// builds deterministic fixtures from REAL, pinned Pokémon TCG data and records
// how the CURRENT evidence model classifies each signal — specifically to answer
// one question: does the model behave correctly when a MAJOR identity sensor
// (artwork identity) is structurally UNAVAILABLE for a game?
//
// THE POKÉMON CONSTRAINT, made concrete:
//   • formatPokemonCard() never populates `illustrationId` — the Pokémon TCG API
//     exposes no deterministic illustration identity. So for EVERY real Pokémon
//     candidate, compareArtwork() sees no candidate illustrationId and returns
//     `unknown`. Artwork is not "sometimes missing" for Pokémon; it is ALWAYS
//     unknown. This is the trust guarantee under test: unknown must never become
//     mismatch, or every Pokémon scan would carry a phantom −2.5 penalty.
//   • Pokémon rarity spellings ("Double Rare", "Special Illustration Rare",
//     "Ultra Rare"…) are NOT in normalizeRarity's table, so compareRarity also
//     returns `unknown` for them — a mapped rarity like "Common" is the
//     exception, not the rule. Recorded here as a calibration observation, not
//     fixed: rarity is largely silent for Pokémon today.
//
// These two facts mean a Pokémon scan leans almost entirely on name + set +
// collector number. Cases 1–4 observe whether that is enough.
//
// Assertions verify OBSERVATIONS about signal composition (match / mismatch /
// unknown and relative ordering) — never final decisions and never a hard-coded
// EvidenceMass total. Each case also renders its composition for human review.
//
// ─── Pinned real data (pokemontcg.io v2; fetched 2026-07-13) ─────────────────
// Charizard ex — Obsidian Flames (set.id "sv3", set.ptcgoCode absent → setCode
// falls back to "sv3"):
//     sv3-125   #125   Double Rare                 (regular art)
//     sv3-223   #223   Special Illustration Rare   (alternate full-art)
// Charizard ex — 151 (set.id "sv3pt5", ptcgoCode absent → setCode "sv3pt5"):
//     sv3pt5-6  #6     Double Rare
// Pikachu — Base (set.id "base1", set.ptcgoCode "BS" → setCode "BS"):
//     base1-58  #58    Common                      (mappable rarity)
// NOTE: none of these carry an illustrationId — the API provides none, and
// formatPokemonCard mirrors that. That absence is the whole subject of Case 3/4.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/pokemon-evidence-calibration.test.ts

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

// ─── Fixture builders ────────────────────────────────────────────────────────

/** A real Pokémon printing, all fields defaulting to the sv3 #125 Charizard ex.
 *  Every default is a genuine pokemontcg.io value — nothing invented. Crucially,
 *  illustrationId is OMITTED, exactly as formatPokemonCard leaves it: the data
 *  source provides no illustration identity, so it must stay absent (→ unknown),
 *  never fabricated. */
function printing(over: Partial<CandidatePrinting> & { externalId: string }): CandidatePrinting {
  return {
    name: "Charizard ex",
    game: "POKEMON",
    setName: "Obsidian Flames",
    setCode: "sv3", // ptcgoCode absent on this set → formatPokemonCard uses set.id
    collectorNumber: "125",
    rarity: "Double Rare",
    imageUrl: "https://example/img.png",
    thumbnailUrl: "https://example/thumb.png",
    price: { marketPrice: 0 },
    // illustrationId deliberately absent — the Pokémon source cannot provide it.
    ...over,
  };
}

/** The OCR/vision readings off ONE scanned card. Only the fields passed were
 *  "read"; everything else is genuinely unobserved (undefined → unknown). The
 *  illustrationId field exists for parity with MTG, but real Pokémon scans never
 *  get a deterministic one — so tests that pass it are exercising the boundary,
 *  not claiming Pokémon supplies artwork identity. */
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
        game: "POKEMON",
        fixture: args.fixture,
        signals: args.signals,
        humanExpectation: args.humanExpectation,
        calibrationNote: args.calibrationNote,
      }) +
      "\n",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Case 1 — Same Pokémon, different sets (cross-set identity separation)
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Charizard ex read as Obsidian Flames (sv3) #125. Candidate A is that
// exact printing; candidate B is Charizard ex from the 151 set (sv3pt5 #6) — the
// SAME Pokémon, a DIFFERENT printing. Observe that name agrees for both while
// set + collector number separate them. Artwork is unknown on both (no source
// illustration identity) and rarity is unknown on both (the shared "Double Rare"
// spelling is unmapped) — so the separation rests entirely on set + CN.

describe("POKEMON calibration — Case 1: same Pokémon, different sets", () => {
  const ev = evidence({
    name: "Charizard ex",
    setCode: "sv3",
    collectorNumber: "125",
    rarity: "Double Rare",
    // no illustrationId: Pokémon vision comparison yields no deterministic id
  });

  const obsidian = printing({ externalId: "sv3-125" }); // exact printing scanned
  const one51 = printing({
    externalId: "sv3pt5-6",
    setName: "151",
    setCode: "sv3pt5",
    collectorNumber: "6",
    rarity: "Double Rare", // same rarity spelling, still unmapped → unknown
  });

  test("name agrees for both; set + collector number separate the printings", () => {
    const sObsidian = assessIdentitySignals(ev, obsidian);
    const sOne51 = assessIdentitySignals(ev, one51);
    record("Case1 sv3 #125 (scanned printing)", sObsidian);
    record("Case1 sv3pt5 #6 (same Pokémon, other set)", sOne51);

    assert.equal(stateOf(sObsidian, "name"), "match");
    assert.equal(stateOf(sOne51, "name"), "match", "same Pokémon name across sets");

    // The 151 printing contradicts on the printing-level fields.
    assert.equal(stateOf(sOne51, "setCode"), "mismatch");
    assert.equal(stateOf(sOne51, "collectorNumber"), "mismatch");
  });

  test("artwork and rarity are unknown on both — set/CN carry the separation", () => {
    const sObsidian = assessIdentitySignals(ev, obsidian);
    const sOne51 = assessIdentitySignals(ev, one51);

    // OBSERVATION: no artwork identity exists for either → unknown, never mismatch.
    assert.equal(stateOf(sObsidian, "artwork"), "unknown");
    assert.equal(stateOf(sOne51, "artwork"), "unknown");
    // OBSERVATION: "Double Rare" is not in normalizeRarity → unknown on both.
    assert.equal(stateOf(sObsidian, "rarity"), "unknown");
    assert.equal(stateOf(sOne51, "rarity"), "unknown");

    // The scanned printing still out-masses the cross-set Pokémon, on set+CN alone.
    const massScanned = calculateEvidenceMass(sObsidian);
    const massOther = calculateEvidenceMass(sOne51);
    assert.ok(
      massScanned > massOther,
      `scanned sv3 #125 (${massScanned}) should out-mass cross-set sv3pt5 #6 (${massOther})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 2 — Same Pokémon, same set, different rarity / art variant
// ═══════════════════════════════════════════════════════════════════════════
// Scan: Charizard ex read as sv3 #125 (Double Rare, regular art). Candidate B is
// the sv3 #223 Special Illustration Rare — the SAME Pokémon in the SAME set, a
// different collectible variant (alternate full-art, higher rarity). Question:
// does rarity support identity WITHOUT dominating it? Observation: for Pokémon,
// rarity is effectively silent — both spellings ("Double Rare" vs "Special
// Illustration Rare") are unmapped → unknown, so the genuinely-different rarity
// is NOT even recorded as a mismatch. Only the collector number separates the
// two variants today; artwork (the real distinguisher) is unavailable.

describe("POKEMON calibration — Case 2: same set, rarity / art variant", () => {
  const ev = evidence({
    name: "Charizard ex",
    setCode: "sv3",
    collectorNumber: "125",
    rarity: "Double Rare",
  });

  const regular = printing({ externalId: "sv3-125" }); // #125 Double Rare, regular art
  const sir = printing({
    externalId: "sv3-223",
    collectorNumber: "223",
    rarity: "Special Illustration Rare", // genuinely different rarity + artwork…
    // …but no illustrationId to encode the art difference, and rarity is unmapped
  });

  test("name + set match both; only collector number separates the variants", () => {
    const sRegular = assessIdentitySignals(ev, regular);
    const sSir = assessIdentitySignals(ev, sir);
    record("Case2 sv3 #125 (regular, scanned)", sRegular);
    record("Case2 sv3 #223 (special illustration rare)", sSir);
    report({
      fixture: "Charizard ex sv3 #223 — Special Illustration Rare variant of scanned #125",
      signals: sSir,
      humanExpectation:
        "Same Pokémon, same set, a different collectible variant — offer #223 as a distinct printing, separated by collector number.",
      calibrationNote:
        "rarity is unmapped for Pokémon (Double Rare vs Special Illustration Rare → unknown), and no artwork id exists; the ONLY signal that distinguishes the art variant today is collectorNumber.",
    });

    assert.equal(stateOf(sSir, "name"), "match");
    assert.equal(stateOf(sSir, "setCode"), "match");
    assert.equal(stateOf(sSir, "collectorNumber"), "mismatch", "only CN separates the variant");
  });

  test("rarity does not dominate: a real rarity difference reads as unknown, not mismatch", () => {
    const sSir = assessIdentitySignals(ev, sir);
    // OBSERVATION (calibration input): the variants ARE different rarities, but
    // because neither spelling maps, compareRarity stands down to unknown — it
    // never becomes a contradiction. Rarity therefore neither supports nor sinks
    // identity for Pokémon under current weights. This is the concrete evidence
    // for whether calibration should teach normalizeRarity the Pokémon vocabulary.
    assert.equal(stateOf(sSir, "rarity"), "unknown");
    assert.equal(stateOf(sSir, "artwork"), "unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 3 — Unknown artwork neutrality (unknown ≠ mismatch)
// ═══════════════════════════════════════════════════════════════════════════
// The trust guarantee, tested arithmetically. For the real Pokémon candidate,
// artwork is unknown (no source illustration identity). We contrast that unknown
// against a hypothetical MISMATCH of the very same signal, and confirm:
//   • unknown contributes exactly 0 to EvidenceMass,
//   • a mismatch would subtract EVIDENCE_WEIGHTS.artwork,
//   • so the unknown mass equals the mass with artwork removed entirely.
// We do NOT fabricate an illustrationId on any candidate to manufacture the
// mismatch — that would invent artwork identity the source cannot provide.
// Instead we take the model's own signals and flip only the artwork STATE, which
// is a pure observation of the aggregation rule.

describe("POKEMON calibration — Case 3: unknown artwork stays neutral", () => {
  const ev = evidence({
    name: "Charizard ex",
    setCode: "sv3",
    collectorNumber: "125",
    // Even if vision reported an id, the candidate has none → artwork unknown.
    illustrationId: "vision-guessed-group-that-cannot-be-verified",
  });

  const real = printing({ externalId: "sv3-125" }); // real Pokémon: no illustrationId

  test("artwork resolves to unknown despite a vision guess, and contributes 0", () => {
    const signals = assessIdentitySignals(ev, real);
    record("Case3 sv3 #125 (artwork unknown)", signals);

    const artwork = signals.find((s) => s.type === "artwork")!;
    assert.equal(artwork.state, "unknown", "no candidate illustrationId → unknown, not mismatch");
    assert.equal(signalContribution(artwork), 0, "unknown artwork contributes exactly 0 mass");
  });

  test("unknown does not subtract: unknown mass == mass-without-artwork, and > a mismatch", () => {
    const signals = assessIdentitySignals(ev, real);
    const massUnknown = calculateEvidenceMass(signals);

    // Mass with the artwork signal removed entirely — the neutral baseline.
    const massWithoutArtwork = calculateEvidenceMass(signals.filter((s) => s.type !== "artwork"));

    // The same signal set, but with artwork flipped to a mismatch (observation of
    // the aggregation rule only — no invented candidate data).
    const asMismatch = signals.map((s) =>
      s.type === "artwork" ? ({ ...s, state: "mismatch" as const }) : s,
    );
    const massMismatch = calculateEvidenceMass(asMismatch);

    // unknown is neutral: it neither adds nor subtracts.
    assert.equal(massUnknown, massWithoutArtwork, "unknown artwork leaves mass unchanged");
    // a mismatch WOULD cost the full artwork weight.
    assert.equal(
      massUnknown - massMismatch,
      EVIDENCE_WEIGHTS.artwork,
      "the unknown→mismatch gap is exactly the artwork weight — this is the guarantee",
    );
    assert.ok(massUnknown > massMismatch, "unknown must never be treated as a contradiction");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Case 4 — Strong deterministic evidence with missing artwork
// ═══════════════════════════════════════════════════════════════════════════
// Can deterministic evidence still strongly confirm identity when the artwork
// sensor is unavailable? Uses Pikachu, Base Set (setCode "BS", #58, Common) —
// chosen because "Common" IS in normalizeRarity, so all four deterministic
// signals (name, set, CN, rarity) can genuinely MATCH while artwork stays
// unknown. Observe that four agreeing deterministic signals produce strong
// positive mass with NO artwork contribution — the Pokémon happy path.

describe("POKEMON calibration — Case 4: strong evidence, artwork unavailable", () => {
  const ev = evidence({
    name: "Pikachu",
    setCode: "BS",
    collectorNumber: "58",
    rarity: "Common", // mappable → a real rarity match, unlike the SV rarities
  });

  const pikachu = printing({
    externalId: "base1-58",
    name: "Pikachu",
    setName: "Base",
    setCode: "BS", // real ptcgoCode for Base Set
    collectorNumber: "58",
    rarity: "Common",
    // still no illustrationId — Base Set cards carry none either
  });

  test("name, set, collector number and rarity all match; artwork is unknown", () => {
    const signals = assessIdentitySignals(ev, pikachu);
    record("Case4 BS #58 Pikachu (four deterministic matches)", signals);
    report({
      fixture: "Pikachu Base Set (BS) #58 Common — full deterministic agreement, artwork unavailable",
      signals,
      humanExpectation:
        "Confirm the card confidently from name + set + collector number + rarity, even though Pokémon supplies no artwork identity.",
      calibrationNote:
        "artwork stays unknown (0), so mass tops out at name+set+CN+rarity = 5.5 — the ceiling for a fully-agreeing Pokémon scan, versus 8.0 for a game that can add an artwork match. Records whether 5.5 is 'strong enough' for a Pokémon accept.",
    });

    assert.equal(stateOf(signals, "name"), "match");
    assert.equal(stateOf(signals, "setCode"), "match");
    assert.equal(stateOf(signals, "collectorNumber"), "match");
    assert.equal(stateOf(signals, "rarity"), "match", "Common IS in normalizeRarity");
    assert.equal(stateOf(signals, "artwork"), "unknown", "no source artwork identity");
  });

  test("deterministic signals alone yield strong positive mass without any artwork term", () => {
    const signals = assessIdentitySignals(ev, pikachu);
    const mass = calculateEvidenceMass(signals);
    const massWithoutArtwork = calculateEvidenceMass(signals.filter((s) => s.type !== "artwork"));

    // OBSERVATION (current weights, recorded — NOT a target): artwork adds nothing,
    // so the full-agreement mass equals the deterministic-only mass, and it is
    // firmly positive. Deterministic evidence carries Pokémon identity on its own.
    assert.equal(mass, massWithoutArtwork, "artwork contributes nothing to a Pokémon match");
    assert.ok(mass > 0, `four agreeing deterministic signals give strong positive mass (${mass})`);
  });
});
