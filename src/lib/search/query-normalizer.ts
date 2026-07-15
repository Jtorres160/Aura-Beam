// ─── Search normalization (Phase 5.12B) ──────────────────────────────────────
// The search layer's single home for COMPARISON VALUES.
//
// The distinction this module exists to protect:
//
//     display value    what is printed on the card — "Blue-Eyes White Dragon"
//     comparison value what we match on            — "blueeyeswhitedragon"
//
// Nothing here mutates a display name. A card always renders with its real
// hyphens, capitals and accents; these functions only produce the throwaway key
// we compare with. Callers that pass a normalized value into a UI have made a
// mistake this module cannot catch for them.
//
// On layering: the fold itself is `foldName`, which already serves the scanner's
// evidence matcher. It is DELEGATED to rather than reimplemented — two folds
// would eventually disagree about the same card, and the one place that would
// surface is a collector's search results. This module is the search layer's
// named seam onto that shared rule, not a second copy of it.

import { foldName } from "@/lib/scanner/evidence";

/**
 * The comparison key for a card or query name.
 *
 * Lowercases, strips accents, and removes every separator — punctuation,
 * hyphens and whitespace alike. This is what makes "Blue Eyes White Dragon"
 * find "Blue-Eyes White Dragon" with no fuzzy scoring and no provider support:
 * both sides fold to the same string, and equality does the rest.
 */
export function normalizeSearchKey(value: string | null | undefined): string {
  return foldName(value ?? "");
}

/**
 * The query's words, each folded, in order. Used for the token-subset tier
 * ("charizard ex" should still reach "Charizard-EX"). Empty words are dropped,
 * so repeated or trailing separators cannot produce a phantom token that
 * nothing can ever match.
 */
export function normalizeTokens(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\s+/)
    .map(normalizeSearchKey)
    .filter(Boolean);
}

/**
 * The comparison value for a collector number.
 *
 * Reconciles the two ways the same number reaches us: printed zero-padded on
 * the card ("006") and stored bare by a source ("6"). Any "/165" suffix is
 * dropped — that is set size, not number. A non-numeric suffix is identity and
 * is kept ("21a" stays distinct from "21").
 *
 * Returns null for absent input, so callers can tell "no number" apart from a
 * number that happens to fold to something falsy.
 */
export function normalizeCollectorNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const head = String(value).split("/")[0].trim().toLowerCase();
  if (!head) return null;
  const m = head.match(/^0*(\d+)([a-z]*)$/);
  return m ? m[1] + m[2] : head;
}

/** The comparison value for a printed set size. Null when genuinely unknown. */
export function normalizeSetSize(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Do these two printed set sizes agree?
 *
 * Returns false when EITHER side is unknown. Note carefully what that does and
 * does not mean: false here is "these do not corroborate", never "these
 * conflict". Callers must not read a false as evidence against the card — see
 * setSizesConflict() for the question that actually asserts disagreement.
 */
export function setSizesMatch(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  const x = normalizeSetSize(a);
  const y = normalizeSetSize(b);
  return x !== null && y !== null && x === y;
}

/**
 * Do these two printed set sizes actively DISAGREE?
 *
 * True only when both are known and differ. This is the Phase 5.10 rule applied
 * to one more field: a source that never told us its set size has not told us
 * the card is wrong. Unavailable evidence is not a contradiction.
 */
export function setSizesConflict(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  const x = normalizeSetSize(a);
  const y = normalizeSetSize(b);
  return x !== null && y !== null && x !== y;
}
