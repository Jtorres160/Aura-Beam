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

/** Collapse a card name to a comparable form: no case, accents or punctuation. */
function normalizeName(name: string): string {
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
  const ocr = normalizeName(ocrName);
  if (!ocr) return false;
  const targets = [candidateName, ...candidateName.split("//")].map(normalizeName);
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

export interface EvidenceSignal {
  type: EvidenceSignalType;
  state: EvidenceState;
  /** Independent strength of this signal when it agrees or contradicts. */
  weight: number;
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

/** Build one signal, resolving `state` against the shared weight table. */
function signal(type: EvidenceSignalType, state: EvidenceState): EvidenceSignal {
  return { type, state, weight: EVIDENCE_WEIGHTS[type] };
}

// Each comparator is deliberately boring: it reports ONLY match / unknown /
// mismatch. It never returns a score. A field the sensor never read, or that the
// candidate's data source cannot provide, is "unknown" — NEVER a mismatch. That
// distinction is the whole point: absence is not contradiction.

function compareName(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.identity.name?.value;
  if (!read || !candidate.name) return signal("name", "unknown");
  return signal("name", nameMatchesOcr(read, candidate.name) ? "match" : "mismatch");
}

function compareSetCode(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.setCode?.value;
  if (!read || !candidate.setCode) return signal("setCode", "unknown");
  return signal("setCode", read.trim().toLowerCase() === candidate.setCode.trim().toLowerCase() ? "match" : "mismatch");
}

function compareCollectorNumber(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.collectorNumber?.value;
  if (!read || !candidate.collectorNumber) return signal("collectorNumber", "unknown");
  return signal(
    "collectorNumber",
    collectorNumberKey(read) === collectorNumberKey(candidate.collectorNumber) ? "match" : "mismatch",
  );
}

function compareRarity(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.rarity?.value;
  if (!read || !candidate.rarity) return signal("rarity", "unknown");
  const a = normalizeRarity(read);
  const b = normalizeRarity(candidate.rarity);
  // Unmappable spellings on either side → stand down (unknown), never mismatch.
  if (a === null || b === null) return signal("rarity", "unknown");
  return signal("rarity", a === b ? "match" : "mismatch");
}

function compareArtwork(evidence: ScanEvidence, candidate: CandidatePrinting): EvidenceSignal {
  const read = evidence.printing.illustrationId?.value;
  // Artwork identity requires BOTH a matched illustration group (from the vision
  // comparison, recorded as evidence) AND a deterministic illustrationId on the
  // candidate. Pokémon sources provide none — that is genuine unknown, not a
  // mismatch, so absence never penalizes a candidate.
  if (!read || !candidate.illustrationId) return signal("artwork", "unknown");
  return signal("artwork", read === candidate.illustrationId ? "match" : "mismatch");
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
