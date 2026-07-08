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
