// ─── Deterministic relevance (Phase 5.12A) ──────────────────────────────────
// Providers are noisy sensors here exactly as vision models are in the scanner.
// We ask them for RECALL (be generous, we'll judge) and we do the judging
// ourselves, deterministically.
//
// This is what makes punctuation tolerance work without any provider support:
// "Blue Eyes White Dragon" asks YGOPRODeck for everything starting "Blue" (69
// cards), and THIS module folds both sides and finds the one card whose folded
// name is exactly "blueeyeswhitedragon" — "Blue-Eyes White Dragon".
//
// No fuzzy scoring model, no AI. Just folding and ordering we can explain to a
// collector.

import { collectorNumbersMatch, type ParsedQuery } from "@/lib/search/query";
import {
  normalizeSearchKey,
  normalizeTokens,
  setSizesConflict,
  setSizesMatch,
} from "@/lib/search/query-normalizer";
import type { CardSearchResult } from "@/lib/search/types";

/** Why a result is in the list, strongest first. Ordering is explainable. */
export type RelevanceTier =
  | "exact"      // folded name is identical to the folded query
  | "prefix"     // folded name starts with the folded query
  | "contains"   // folded query appears inside the folded name
  | "tokens";    // every word of the query appears in the name, in any order

const TIER_RANK: Record<RelevanceTier, number> = {
  exact: 0,
  prefix: 1,
  contains: 2,
  tokens: 3,
};

/**
 * How strongly the card's PRINTED NUMBER evidence agrees with the query, as an
 * ordered ladder — lower is stronger. This is the Phase 5.12B addition: "006"
 * and "006/165" are not the same claim, and the second one is stronger.
 *
 * The ordering encodes one rule, twice:
 *
 *   corroborated  both the number AND the printed set size agree. The collector
 *                 read us two facts off the card and both hold. Nothing beats it.
 *   agrees        the number agrees; set size is unknown on one side. Real
 *                 evidence, simply not corroborated.
 *   neutral       one side named no number at all. No claim either way — which
 *                 must rank ABOVE any form of disagreement, because a source
 *                 that stayed silent has not told us the card is wrong.
 *   sizeConflicts the number agrees but the printed set size does not. This is
 *                 a different printing of the same number — probably not it.
 *   conflicts     the numbers themselves disagree. Weakest, still not removed.
 */
type NumberAgreement = "corroborated" | "agrees" | "neutral" | "sizeConflicts" | "conflicts";

const AGREEMENT_RANK: Record<NumberAgreement, number> = {
  corroborated: 0,
  agrees: 1,
  neutral: 2,
  sizeConflicts: 3,
  conflicts: 4,
};

export interface RankedResult {
  card: CardSearchResult;
  tier: RelevanceTier;
  agreement: NumberAgreement;
}

/**
 * Weigh the query's printed-number evidence against one card.
 *
 * Every "unknown" path lands on `neutral` or better — never on a conflict. A
 * source that omits a collector number or a set size has produced UNAVAILABLE
 * evidence, and unavailable evidence is not a contradiction (Phase 5.10).
 */
function weighNumbers(parsed: ParsedQuery, card: CardSearchResult): NumberAgreement {
  if (!parsed.collectorNumber || !card.collectorNumber) return "neutral";

  if (!collectorNumbersMatch(parsed.collectorNumber, card.collectorNumber)) return "conflicts";

  // The number agrees. Does the printed set size corroborate or contradict it?
  if (setSizesMatch(parsed.setSize, card.set.printedSize)) return "corroborated";
  if (setSizesConflict(parsed.setSize, card.set.printedSize)) return "sizeConflicts";
  return "agrees";
}

/**
 * Judge one card against the parsed query. Returns null when the card is not a
 * plausible answer at all — that is a real "this is not the card", not a
 * failure, so dropping it here is safe.
 */
function judge(parsed: ParsedQuery, card: CardSearchResult): RankedResult | null {
  const target = normalizeSearchKey(card.name);
  const q = parsed.foldedName;

  let tier: RelevanceTier | null = null;
  if (q.length === 0) {
    // Number-only query ("006/165"): the name cannot rank it; the collector
    // number below is the only signal. Admit everything and let it decide.
    tier = "tokens";
  } else if (target === q) {
    tier = "exact";
  } else if (target.startsWith(q)) {
    tier = "prefix";
  } else if (target.includes(q)) {
    tier = "contains";
  } else {
    // Token subset — "charizard ex" should still find "Charizard ex" even if a
    // source spells it "Charizard-EX". Each query word must appear.
    const words = normalizeTokens(parsed.name);
    if (words.length > 0 && words.every((w) => target.includes(w))) tier = "tokens";
  }

  if (!tier) return null;

  return { card, tier, agreement: weighNumbers(parsed, card) };
}

/**
 * Filter and order results for one query.
 *
 * The comparison keys, strongest first — this ordering IS the phase's thesis:
 *
 *   1. name tier        exact folded name, then prefix/contains/token. What the
 *                       collector typed is the primary claim; a number refines
 *                       WHICH printing, it does not overrule WHICH CARD.
 *   2. number agreement  the ladder above: corroborated > agrees > neutral >
 *                       size conflict > number conflict.
 *   3. artwork present   a result we can actually show the collector, before one
 *                       we can only name. Presentation completeness, deliberately
 *                       LAST of the substantive keys — it is not identity.
 *   4. name length, then alphabetical — a deterministic, explainable tiebreak.
 *
 * What is absent from that list is the point: MARKET PRICE IS NOT A KEY. Price
 * is a fact about a card, never evidence of which card it is. A ranker that
 * promotes the expensive printing is flattering the collector, not identifying
 * their card — and Aura would rather be right than exciting.
 *
 * Nothing here is ever REMOVED for disagreeing. A conflicting number sinks; it
 * does not vanish. Only judge() drops a card, and only when the name makes it no
 * answer at all.
 */
export function rankResults(parsed: ParsedQuery, cards: CardSearchResult[]): CardSearchResult[] {
  const judged = cards
    .map((c) => judge(parsed, c))
    .filter((r): r is RankedResult => r !== null);

  const hasArtwork = (r: RankedResult) =>
    Boolean(r.card.artwork.imageUrl || r.card.artwork.thumbnailUrl);

  judged.sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];

    const agreement = AGREEMENT_RANK[a.agreement] - AGREEMENT_RANK[b.agreement];
    if (agreement !== 0) return agreement;

    if (hasArtwork(a) !== hasArtwork(b)) return hasArtwork(a) ? -1 : 1;

    // Stable, explainable tiebreak: shorter names are the plainer printing
    // ("Charizard" before "Charizard & Braixen GX"), then alphabetical.
    if (a.card.name.length !== b.card.name.length) return a.card.name.length - b.card.name.length;
    return a.card.name.localeCompare(b.card.name);
  });

  return judged.map((r) => r.card);
}
