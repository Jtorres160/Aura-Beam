// ═══════════════════════════════════════════════════════════
// Aura — Market price: "unpriced" vs "worth nothing"
// ═══════════════════════════════════════════════════════════
// One rule, in one place, so every surface says the same thing.
//
// WRITE SIDE (fixed): every provider extractor now passes a missing quote
// through as `null` (see PrintingPrice.marketPrice in lib/scanner/evidence.ts).
// A card nobody has priced is stored as null, distinct from a real figure.
//
// READ SIDE (this file): rows written BEFORE that fix had their absence
// coalesced to 0 on the way in, and that is not recoverable after the fact —
// nothing in the database records which zeros were quotes and which were
// silence. So on read we apply a DISCLOSED CONVENTION: a stored 0 is treated
// as "no market data", the same as null.
//
// Why that is defensible rather than a guess: for a real, tradeable TCG card a
// true market price of exactly $0.00 does not occur — the cheapest bulk commons
// still quote a few cents. A stored 0 is therefore overwhelmingly likely to be
// a recorded silence, and showing "$0.00" as if it were a valuation is the
// worse error of the two. It is still a convention, not a measurement, and it
// is documented as such in the PR that introduced it.
//
// This convention shrinks on its own: every refresh of an unpriced card now
// writes null instead of 0.

/**
 * A stored/quoted market price → the figure to display, or null for
 * "no market data". Applies the legacy-zero convention documented above.
 */
export function displayMarketPrice(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** A market price formatted for display, or null when there is no data to show.
 *  Callers render the null case as words ("No market data"), never as a figure. */
export function formatMarketPrice(raw: unknown): string | null {
  const value = displayMarketPrice(raw);
  if (value === null) return null;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
