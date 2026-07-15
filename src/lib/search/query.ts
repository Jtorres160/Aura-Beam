// ─── Query intelligence (Phase 5.12A) ───────────────────────────────────────
// Collectors do not type database queries. They type what is printed on the
// card in front of them:
//
//     "Charizard 006/165"        name + collector number
//     "Blue Eyes White Dragon"   the hyphen forgotten
//     "charizard ex"             no capitals
//
// This module turns that into structured intent. It PARSES ONLY — it never
// decides what matches. Retrieval judges matches downstream (see match.ts).

import { normalizeCollectorNumber, normalizeSearchKey } from "@/lib/search/query-normalizer";

export interface ParsedQuery {
  /** Exactly what the collector typed, untouched. */
  raw: string;
  /** The name portion, with any recognized collector/number tokens removed. */
  name: string;
  /** Punctuation/case/accent-folded `name`, for deterministic comparison. */
  foldedName: string;
  /** e.g. "006" from "Charizard 006/165", or "267" from "#267". */
  collectorNumber: string | null;
  /** e.g. "165" from "006/165" — the set's printed card count. */
  setSize: string | null;
  /** True when the query carries no usable name (e.g. just "006/165"). */
  isNumberOnly: boolean;
}

// "006/165", "6/165", "SV3-021/198" → capture the number and the set size.
const FRACTION_RE = /(?:^|\s)(\d{1,4})\s*\/\s*(\d{1,4})(?=\s|$)/;
// "#267" — an explicit collector-number sigil.
const HASH_RE = /(?:^|\s)#\s*(\d{1,5})(?=\s|$)/;

/**
 * Parse a raw search string into name + printed-number intent.
 *
 * Deliberately conservative: a BARE trailing number ("Charizard 4") is NOT read
 * as a collector number. It is genuinely ambiguous — it may be part of the name
 * — and a wrong parse silently filters away the right card. Only the explicit,
 * unambiguous forms ("006/165", "#267") are trusted. Aura would rather search
 * broadly than narrow on a guess.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const input = (raw ?? "").trim().replace(/\s+/g, " ");
  let rest = input;
  let collectorNumber: string | null = null;
  let setSize: string | null = null;

  const fraction = rest.match(FRACTION_RE);
  if (fraction) {
    collectorNumber = fraction[1];
    setSize = fraction[2];
    rest = rest.replace(fraction[0], " ");
  } else {
    const hash = rest.match(HASH_RE);
    if (hash) {
      collectorNumber = hash[1];
      rest = rest.replace(hash[0], " ");
    }
  }

  const name = rest.trim().replace(/\s+/g, " ");
  return {
    raw: input,
    name,
    foldedName: normalizeSearchKey(name),
    collectorNumber,
    setSize,
    isNumberOnly: name.length === 0 && collectorNumber !== null,
  };
}

/**
 * Do these two collector numbers name the same printing? Tolerates the
 * zero-padding difference between what is printed ("006") and what sources
 * store ("6"), and ignores any "/165" suffix a source may include.
 */
export function collectorNumbersMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = normalizeCollectorNumber(a);
  const y = normalizeCollectorNumber(b);
  return x !== null && y !== null && x === y;
}
