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
