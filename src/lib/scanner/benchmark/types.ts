// ─── Recognition Benchmark Dataset — types (Scanner V2 · Milestone 0) ────────
// The formal, versioned regression suite for EVERY future recognizer change.
// A benchmark entry pairs a real card image with its known identity and the
// difficulty conditions it exercises, so that "did this recognizer improve?"
// becomes a measurable question with a fixed denominator rather than a vibe.
//
// The dataset lives in the repo (manifest.json + images/), NOT the database, so
// it is reviewable in a diff, travels with the code, and versions alongside the
// recognizer it grades. M0 defines and validates the structure; entries are
// added over time as real, rights-cleared card photos are collected.

/**
 * The conditions a benchmark image exercises. A recognizer's score is reported
 * PER category, because "97% overall" hides a collapse on holos or promos — the
 * exact cards collectors care about most. Every entry declares at least one.
 */
export const DIFFICULTY_CATEGORIES = [
  "easy",         // clean, well-lit, unsleeved, standard printing
  "alt-art",      // alternate / full-art / extended-art printing
  "holo",         // holofoil rare
  "reverse-holo", // reverse-holo (foil everywhere but the art)
  "foil",         // MTG-style foil / etched / textured
  "promo",        // promotional printing (shared art, different stamp/set)
  "vintage",      // old frames / pre-modern layouts
  "sleeved",      // photographed through a sleeve (glare/reflection)
  "damaged",      // wear, scratches, whitening, creases
  "multilang",    // a non-English printing
  "glare",        // strong specular highlight across the card
  "angled",       // significant perspective / rotation
] as const;

export type DifficultyCategory = (typeof DIFFICULTY_CATEGORIES)[number];

/** The game a benchmark card belongs to — the same vocabulary the pipeline uses. */
export type BenchmarkGame = "MTG" | "POKEMON" | "YUGIOH";

/**
 * One graded case: an image and the truth it must resolve to.
 *
 * `expectedExternalId` is the PRINTING-level truth (the provider id the pipeline
 * would persist). It is optional because for some hard photos the exact printing
 * is genuinely ambiguous even to a human — those still grade recognition at the
 * IDENTITY level (name + game) via `expectedName`, and simply don't count toward
 * printing-precision. Encoding that honestly is the point: a benchmark that
 * pretends every card has a knowable printing would reward guessing.
 */
export interface BenchmarkEntry {
  /** Stable unique id for this case (kebab, e.g. "pokemon-base-charizard-holo"). */
  id: string;
  /** Filename under benchmark/images/ (not a path — the loader joins it). */
  image: string;
  game: BenchmarkGame;
  /** Identity-level truth: the official English card name. Always required. */
  expectedName: string;
  /** Printing-level truth: the provider externalId, when it is knowable. */
  expectedExternalId?: string;
  /** Human-readable printing (set + number), for report legibility. */
  expectedPrinting?: string;
  /** At least one difficulty condition this image exercises. */
  categories: DifficultyCategory[];
  /** Optional provenance / notes (source of the photo, why it's here). */
  notes?: string;
}

export interface BenchmarkManifest {
  /** Schema version of the manifest shape itself. */
  v: 1;
  /** Free-text description of what this dataset covers. */
  description: string;
  entries: BenchmarkEntry[];
}
