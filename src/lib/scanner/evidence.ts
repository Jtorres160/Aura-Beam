// ─── Scan Evidence Model ────────────────────────────────────────────────────
// Core principle of the scanner pipeline:
//
//   AI models (OCR / vision) are noisy SENSORS. They read things off the card
//   and report each reading with a confidence. Deterministic code combines
//   the readings and makes the identification decision.
//
// No model output is ever accepted directly as a final identification.
//
// The critical distinction below is IDENTITY vs PRINTING evidence:
//   - Identity evidence answers "which card is this?"  (e.g. "Counterspell")
//   - Printing evidence answers "which printing of it?" (e.g. "MH2 #267")
// A printing-level answer requires printing-level evidence. Artwork only
// counts as printing evidence between candidates with DIFFERENT illustrations.

/** Belief that a reading is correct, in [0, 1]. */
export type Confidence = number;

/** Where a reading came from. */
export type EvidenceSource =
  | "ocr-full"        // full-card OCR pass
  | "ocr-strip"       // dedicated bottom-strip OCR pass (Phase 3)
  | "vision-compare"  // visual comparison against candidate images
  | "search"          // derived from a card-database lookup
  | "user";           // explicit user input

/** A single observed value with its confidence and provenance. */
export interface FieldReading<T = string> {
  value: T;
  confidence: Confidence;
  source: EvidenceSource;
}

export type GameId = "MTG" | "POKEMON" | "YUGIOH";

/** Evidence about WHICH CARD this is. Cannot distinguish printings. */
export interface IdentityEvidence {
  name?: FieldReading;
  game?: FieldReading<GameId>;
  typeLine?: FieldReading;
  manaCost?: FieldReading;
  powerToughness?: FieldReading;
}

/** Evidence about WHICH PRINTING of the card this is. */
export interface PrintingEvidence {
  setCode?: FieldReading;
  collectorNumber?: FieldReading;
  rarity?: FieldReading;         // printed rarity letter/word, e.g. "R", "Mythic"
  frame?: FieldReading;          // e.g. "1997" (retro), "2015" (modern), "future"
  borderColor?: FieldReading;    // e.g. "black", "white", "borderless"
  language?: FieldReading;       // e.g. "en", "ja"
  finish?: FieldReading;         // e.g. "foil", "nonfoil", "etched"
  isPromo?: FieldReading<boolean>;
  /** Which illustration group the scan matched (set by vision comparison). */
  illustrationId?: FieldReading;
}

/** Everything the pipeline has observed about one scan. */
export interface ScanEvidence {
  identity: IdentityEvidence;
  printing: PrintingEvidence;
}

export function reading<T>(value: T, confidence: Confidence, source: EvidenceSource): FieldReading<T> {
  return { value, confidence, source };
}

// ─── Artwork Boundary (Phase 5.5) ──────────────────────────────────────────
// A decision constraint, not evidence. Answers: "can the system know artwork
// deterministically from the data source?" Used by gateDecision to determine
// whether art-group-vision matches with narrow margins require user selection.
// Does NOT penalize any game; only gates decisions when artwork identity is
// unavailable AND margin is narrow.

export type ArtworkIdentitySource = "illustration-id" | "card-image-id" | "none";
export type ArtworkConfidenceLevel = "deterministic" | "uncertain";

export interface ArtworkBoundary {
  /** Can this source provide deterministic artwork identity? */
  hasDeterministicArtworkId: boolean;

  /** Should narrow-margin art-group-vision matches require user selection? */
  requiresUserSelectionWhenArtworkUncertain: boolean;

  /** Which field/mechanism provides (or lacks) artwork identity. */
  artworkIdentitySource: ArtworkIdentitySource;

  /** Certainty level of artwork identity for this source. */
  artworkConfidence: ArtworkConfidenceLevel;
}

/** Assess artwork boundary for a given game.
 *  A pure, deterministic function of the game — not dependent on OCR or any
 *  extracted evidence. Describes what the data source CAN provide. */
export function assessArtworkBoundary(game: GameId): ArtworkBoundary {
  switch (game) {
    case "MTG":
      return {
        hasDeterministicArtworkId: true,
        requiresUserSelectionWhenArtworkUncertain: false,
        artworkIdentitySource: "illustration-id",
        artworkConfidence: "deterministic",
      };

    case "YUGIOH":
      return {
        hasDeterministicArtworkId: true,
        requiresUserSelectionWhenArtworkUncertain: false,
        artworkIdentitySource: "card-image-id",
        artworkConfidence: "deterministic",
      };

    case "POKEMON":
      return {
        hasDeterministicArtworkId: false,
        requiresUserSelectionWhenArtworkUncertain: true,
        artworkIdentitySource: "none",
        artworkConfidence: "uncertain",
      };
  }
}

// ─── Set/CN sensor trust (Phase 3) ──────────────────────────────────────────
// Base belief in each sensor's set-code / collector-number reading, BEFORE the
// reconciler weighs them. The dedicated strip pass reads that tiny bottom-edge
// text as its whole subject at high detail, so it outranks the full-card pass,
// which only reads it incidentally. Independent agreement between the two passes
// is the strongest signal of all — two sensors are unlikely to share a misread.
export const SET_CN_CONFIDENCE = {
  full: 0.5,
  strip: 0.75,
  agree: 0.95,
} as const;

/** The reconciled set/CN plus the winning readings, for logging and evidence. */
export interface ReconciledSetCn {
  setCode: string;
  collectorNumber: string;
  setCodeReading?: FieldReading;
  collectorNumberReading?: FieldReading;
}

/**
 * Collapse a collector number to a comparable key: leading token only
 * ("267/303" ≡ "267"), case-insensitive, zero-padding dropped ("021" ≡ "21" —
 * Pokemon prints padded numbers but the card database stores them bare).
 */
export function collectorNumberKey(cn: string): string {
  return cn.split("/")[0].trim().toLowerCase().replace(/^0+(?=\d)/, "");
}

/**
 * Reconcile one field across the two OCR passes deterministically. The strip
 * pass is the targeted sensor, so it wins on disagreement or when the full pass
 * missed the field; when both passes independently agree we trust the value
 * most. Returns the winning reading, or undefined when neither pass read it.
 */
function reconcileField(
  fullValue: string,
  stripReading: FieldReading | undefined,
  agrees: (a: string, b: string) => boolean,
): FieldReading | undefined {
  const full = (fullValue || "").trim();
  const strip = (stripReading?.value || "").trim();
  if (strip && full && agrees(strip, full)) return reading(strip, SET_CN_CONFIDENCE.agree, "ocr-strip");
  if (strip) return reading(strip, stripReading!.confidence, "ocr-strip");
  if (full) return reading(full, SET_CN_CONFIDENCE.full, "ocr-full");
  return undefined;
}

/**
 * Combine the full-card OCR pass and the dedicated bottom-strip pass (Phase 3)
 * into the set/CN the decision layer should act on. Pure and deterministic —
 * the models are sensors; this reconciliation is the code that judges them.
 */
export function reconcileSetCn(
  full: { setCode: string; collectorNumber: string },
  strip: { setCode?: FieldReading; collectorNumber?: FieldReading },
): ReconciledSetCn {
  const setCodeReading = reconcileField(
    full.setCode,
    strip.setCode,
    (a, b) => a.toLowerCase() === b.toLowerCase(),
  );
  const collectorNumberReading = reconcileField(
    full.collectorNumber,
    strip.collectorNumber,
    (a, b) => collectorNumberKey(a) === collectorNumberKey(b),
  );
  return {
    setCode: setCodeReading?.value ?? "",
    collectorNumber: collectorNumberReading?.value ?? "",
    setCodeReading,
    collectorNumberReading,
  };
}

// ─── Candidate Printings ────────────────────────────────────────────────────
// The normalized shape every game service formats external cards into.
// The printing-evidence fields are complete for MTG (Scryfall provides them);
// Pokemon/Yugioh fill what their data sources expose until the Phase 5 mirror.

export interface PrintingPrice {
  marketPrice: number;
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
}

export interface CandidatePrinting {
  externalId: string;
  name: string;
  game: GameId;
  setName: string;
  setCode?: string | null;
  /** Cards printed in the set — the "165" in "006/165". Null where a source
   *  does not expose one; absence must never be read as a mismatch. */
  setPrintedSize?: number | null;
  collectorNumber?: string | null;
  rarity: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  price: PrintingPrice;
  // printing evidence from the card database
  oracleId?: string | null;
  illustrationId?: string | null;
  frame?: string | null;
  borderColor?: string | null;
  finishes?: string[];
  promoTypes?: string[];
  lang?: string | null;
}

// ─── Text normalization (shared, layer-neutral) ──────────────────────────────
// Pure string helpers that turn noisy OCR/database spellings into comparable
// tokens. They live in the evidence layer — the lowest layer — so both the
// decision layer (nameMatchesOcr in candidates.ts) and the scorer (rarity guard)
// depend DOWNWARD on them. No scoring, ranking, or decision policy here.

/** Collapse a card name to a comparable form: no case, accents or punctuation.
 *  Exported because the search layer (Phase 5.12A) must fold names EXACTLY as
 *  the scanner does — two different foldings would make the same two cards
 *  "equal" in one layer and distinct in the other. */
export function foldName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Bounded edit distance for OCR noise tolerance. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/**
 * Does an OCR'd name refer to this candidate card? Backs the "set-cn-verified"
 * method: a set+collector lookup only earns its high confidence when the name
 * on the card agrees with the card the lookup returned. Tolerates OCR noise
 * (case, accents, punctuation, up to 2 typos on longer names) and double-faced
 * names, where OCR usually reads only the front face.
 */
export function nameMatchesOcr(ocrName: string, candidateName: string): boolean {
  const ocr = foldName(ocrName);
  if (!ocr) return false;
  const targets = [candidateName, ...candidateName.split("//")].map(foldName);
  for (const target of targets) {
    if (!target) continue;
    if (target === ocr) return true;
    if (target.length >= 8 && editDistance(ocr, target) <= 2) return true;
  }
  return false;
}

/** Map the many printed/database rarity spellings onto one comparable token.
 *  Unknown spellings return null so comparisons stand down — conservative. */
export function normalizeRarity(raw: string): string | null {
  const map: Record<string, string> = {
    c: "common", common: "common",
    u: "uncommon", uncommon: "uncommon",
    r: "rare", rare: "rare",
    m: "mythic", mythic: "mythic", "mythic rare": "mythic",
  };
  return map[raw.trim().toLowerCase()] ?? null;
}

// ─── Identity Evidence Signals (Phase 5.5, Batch 3) ──────────────────────────
// The evidence layer answers ONE question: which independent identity signals
// exist between what the sensors read and a candidate printing, and how strong
// is each? It does NOT know about vision confidence, margins, winners, or accept
// thresholds — those live in ranking and the decision gate. This keeps the
// pipeline arrow honest:
//
//   Evidence Extraction → Evidence Signals → EvidenceMass → Ranking → Decision
//
// EvidenceMass is INDEPENDENT CONFIRMATION, not a probability and not a restated
// vision score. Vision saying "looks like Charizard" and the artwork boundary
// saying "this illustrationId matches" are SEPARATE sensors — artwork identity
// is one signal here; vision confidence never enters this layer at all.

export type EvidenceSignalType =
  | "name"
  | "setCode"
  | "collectorNumber"
  | "rarity"
  | "artwork";

export type EvidenceState = "match" | "unknown" | "mismatch";

// ─── Evidence Coverage Model (Phase 5.10) ────────────────────────────────────
// A signal's STATE (match/unknown/mismatch) answers "did the reading agree?".
// Its AVAILABILITY answers a different, orthogonal question: "should this sensor
// have produced a reading at all?". These are independent axes. Availability
// exists to resolve the ambiguity calibration surfaced: an `unknown` state can
// mean two completely different things —
//
//   • The data source structurally does NOT provide this signal for this game
//     (Pokémon artwork identity, Yu-Gi-Oh collector number). Missing information.
//   • The source DOES provide it, but the sensor produced no reading this scan
//     (an MTG artwork comparison that should have run but didn't). Bad — or at
//     least incomplete — information.
//
// Both still contribute 0 to EvidenceMass (unknown ≠ mismatch is untouched), but
// only the SECOND is a coverage gap worth flagging. Availability lets Aura tell
// "I don't have this sensor" apart from "my sensor failed" WITHOUT changing a
// single weight, threshold, or ranking rule.
export type SignalAvailability =
  | "supported"    // the source provides this signal AND a reading was produced
  | "unavailable"  // the source does not provide this signal for this game
  | "failed";      // the source provides it, but no reading was produced this scan

export interface EvidenceSignal {
  type: EvidenceSignalType;
  state: EvidenceState;
  /** Independent strength of this signal when it agrees or contradicts. */
  weight: number;
  /** Whether this sensor was even expected to produce a reading (Phase 5.10).
   *  Purely descriptive — it never enters EvidenceMass; unknown stays neutral
   *  regardless of whether it is `unavailable` or `failed`. */
  availability: SignalAvailability;
}

/**
 * Source capability: for a given game, which identity signals can the card data
 * source provide AT ALL? This is a pure, declarative statement of capability —
 * NOT a per-scan reading and NOT a game hack scattered through the comparators.
 * It mirrors the cross-game evidence map established during calibration:
 *
 *   MTG      name ✓  setCode ✓  collectorNumber ✓  rarity ✓  artwork ✓   (5/5)
 *   Pokémon  name ✓  setCode ✓  collectorNumber ✓  rarity ✓  artwork ✗   (4/5)
 *   Yu-Gi-Oh name ✓  setCode ✓  collectorNumber ✗  rarity ✓  artwork ✓   (4/5)
 *
 * (Pokémon/Yu-Gi-Oh rarity is only PARTIALLY mapped by normalizeRarity today —
 * calibration recorded that separately — but the source does expose a rarity
 * field, so the capability is present. Capability is about what the source can
 * provide, not whether every value maps.)
 *
 * A comparator uses this to decide, when it reports `unknown`, whether the miss
 * is `unavailable` (capability false) or `failed` (capability true). Adding a
 * game means adding a row here — never an `if (game === …)` in a comparator.
 */
export type SourceCapabilities = Record<EvidenceSignalType, boolean>;

export function assessSourceCapabilities(game: GameId): SourceCapabilities {
  switch (game) {
    case "MTG":
      return { name: true, setCode: true, collectorNumber: true, rarity: true, artwork: true };
    case "POKEMON":
      // Artwork identity is structurally unavailable (no illustration id source).
      return { name: true, setCode: true, collectorNumber: true, rarity: true, artwork: false };
    case "YUGIOH":
      // Collector number is structurally unavailable (the set code embeds it).
      return { name: true, setCode: true, collectorNumber: false, rarity: true, artwork: true };
  }
}

/**
 * Resolve a signal's availability from its state and the source's capability.
 * A produced reading (match/mismatch) is always `supported`. Only an `unknown`
 * needs disambiguating: the source either cannot provide it (`unavailable`) or
 * could but didn't this scan (`failed`).
 */
function availabilityFor(
  game: GameId,
  type: EvidenceSignalType,
  state: EvidenceState,
): SignalAvailability {
  if (state !== "unknown") return "supported";
  return assessSourceCapabilities(game)[type] ? "failed" : "unavailable";
}

/**
 * Per-signal weight — the evidence POLICY, deliberately separate from the
 * extraction comparators (which only report match/unknown/mismatch). Roughly
 * mirrors the AGENTS.md evidence tiers: collector number, set code, exact name
 * and artwork identity are "very strong"; printed rarity is merely "strong".
 * Tune these without touching a single comparator.
 */
export const EVIDENCE_WEIGHTS: Record<EvidenceSignalType, number> = {
  name: 1.5,
  setCode: 1.5,
  collectorNumber: 2.0,
  rarity: 0.5,
  artwork: 2.5,
};

/** Build one signal, resolving `state` against the shared weight table and the
 *  source's capability for `game` (which fixes availability, Phase 5.10). */
function signal(type: EvidenceSignalType, state: EvidenceState, game: GameId): EvidenceSignal {
  return {
    type,
    state,
    weight: EVIDENCE_WEIGHTS[type],
    availability: availabilityFor(game, type, state),
  };
}

// Each comparator is deliberately boring: it reports ONLY match / unknown /
// mismatch. It never returns a score. A field the sensor never read, or that the
// candidate's data source cannot provide, is "unknown" — NEVER a mismatch. That
// distinction is the whole point: absence is not contradiction.

function compareName(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.identity.name?.value;
  if (!read || !candidate.name) return signal("name", "unknown", candidate.game);
  return signal("name", nameMatchesOcr(read, candidate.name) ? "match" : "mismatch", candidate.game);
}

function compareSetCode(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.setCode?.value;
  if (!read || !candidate.setCode) return signal("setCode", "unknown", candidate.game);
  return signal(
    "setCode",
    read.trim().toLowerCase() === candidate.setCode.trim().toLowerCase() ? "match" : "mismatch",
    candidate.game,
  );
}

function compareCollectorNumber(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.collectorNumber?.value;
  if (!read || !candidate.collectorNumber) return signal("collectorNumber", "unknown", candidate.game);
  return signal(
    "collectorNumber",
    collectorNumberKey(read) === collectorNumberKey(candidate.collectorNumber) ? "match" : "mismatch",
    candidate.game,
  );
}

function compareRarity(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.rarity?.value;
  if (!read || !candidate.rarity) return signal("rarity", "unknown", candidate.game);
  const a = normalizeRarity(read);
  const b = normalizeRarity(candidate.rarity);
  // Unmappable spellings on either side → stand down (unknown), never mismatch.
  if (a === null || b === null) return signal("rarity", "unknown", candidate.game);
  return signal("rarity", a === b ? "match" : "mismatch", candidate.game);
}

function compareArtwork(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.illustrationId?.value;
  // Artwork identity requires BOTH a matched illustration group (from the vision
  // comparison, recorded as evidence) AND a deterministic illustrationId on the
  // candidate. Pokémon sources provide none — that is genuine unknown, not a
  // mismatch, so absence never penalizes a candidate.
  if (!read || !candidate.illustrationId) return signal("artwork", "unknown", candidate.game);
  return signal("artwork", read === candidate.illustrationId ? "match" : "mismatch", candidate.game);
}

/**
 * Report the independent identity signals between one scan's evidence and one
 * candidate printing. Pure and deterministic — no vision score, no ranking, no
 * thresholds. The ordering of signals is stable for telemetry.
 */
export function assessIdentitySignals(
  evidence: ScanEvidence,
  candidate: CandidatePrinting,
): EvidenceSignal[] {
  return [
    compareName(evidence, candidate),
    compareSetCode(evidence, candidate),
    compareCollectorNumber(evidence, candidate),
    compareRarity(evidence, candidate),
    compareArtwork(evidence, candidate),
  ];
}

/**
 * Aggregate signals into EvidenceMass: the net independent confirmation for a
 * candidate. A matching signal adds its weight; a contradicting signal subtracts
 * it; an unknown signal contributes NOTHING. That asymmetry is essential —
 * `unknown` must never equal `mismatch`, or a missing collector number would
 * read as a contradiction. Vision confidence is not a term in this sum.
 */
export function calculateEvidenceMass(signals: EvidenceSignal[]): number {
  return signals.reduce((total, s) => {
    if (s.state === "match") return total + s.weight;
    if (s.state === "mismatch") return total - s.weight;
    return total; // unknown → neutral
  }, 0);
}

// ─── Evidence Coverage (Phase 5.10) ──────────────────────────────────────────
// Coverage summarizes the AVAILABILITY axis of an assessment: of the sensors
// that could have fired, how many did? It is OBSERVATIONAL — it answers the
// calibration questions ("how many expected sensors were available?", "is the
// EvidenceMass being limited by unavailable data?") without feeding back into
// mass, ranking, or the decision gate. It is deliberately kept separate from
// EvidenceMass so score quality and score CONTEXT never get blended.

export interface EvidenceCoverage {
  /** Sensors the source is expected to provide for this game (present + failed). */
  expected: number;
  /** Expected sensors that produced a reading this scan (availability "supported"). */
  present: number;
  /** Expected sensors that produced NO reading this scan (availability "failed"). */
  failed: number;
  /** Sensors the source cannot provide for this game (availability "unavailable"). */
  unavailable: number;
  /** Total signals assessed (present + failed + unavailable). */
  total: number;
}

/**
 * Summarize the coverage of an assessed signal set. Pure and derived — it reads
 * each signal's `availability` and tallies it. `expected` counts the sensors the
 * source SHOULD provide (so it is stable even when a supported sensor fails),
 * while `present` counts those that actually fired. Never an input to any
 * decision; carried alongside EvidenceMass purely so Aura can report the
 * confidence CONTEXT behind a score.
 */
export function calculateEvidenceCoverage(signals: EvidenceSignal[]): EvidenceCoverage {
  let present = 0;
  let failed = 0;
  let unavailable = 0;
  for (const s of signals) {
    if (s.availability === "supported") present++;
    else if (s.availability === "failed") failed++;
    else unavailable++;
  }
  return { expected: present + failed, present, failed, unavailable, total: signals.length };
}
