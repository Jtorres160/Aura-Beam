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

import { foldName } from "@/lib/scanner/evidence";
import { collectorNumbersMatch, type ParsedQuery } from "@/lib/search/query";
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

export interface RankedResult {
  card: CardSearchResult;
  tier: RelevanceTier;
  /** The query named a collector number and this card carries the same one. */
  collectorNumberAgrees: boolean;
  /** Query and card both name a collector number, and they DISAGREE. */
  collectorNumberConflicts: boolean;
}

/**
 * Judge one card against the parsed query. Returns null when the card is not a
 * plausible answer at all — that is a real "this is not the card", not a
 * failure, so dropping it here is safe.
 */
function judge(parsed: ParsedQuery, card: CardSearchResult): RankedResult | null {
  const target = foldName(card.name);
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
    const words = parsed.name.split(/\s+/).map(foldName).filter(Boolean);
    if (words.length > 0 && words.every((w) => target.includes(w))) tier = "tokens";
  }

  if (!tier) return null;

  const bothHaveCn = Boolean(parsed.collectorNumber && card.collectorNumber);
  const agrees = bothHaveCn && collectorNumbersMatch(parsed.collectorNumber, card.collectorNumber);

  return {
    card,
    tier,
    collectorNumberAgrees: agrees,
    collectorNumberConflicts: bothHaveCn && !agrees,
  };
}

/**
 * Filter and order results for one query.
 *
 * On collector numbers: a card whose number AGREES is promoted above everything
 * else — that is the collector telling us exactly which printing they hold. A
 * card whose number CONFLICTS is demoted but NOT removed, because a source that
 * omits or misspells a collector number must not cause us to assert the card
 * does not exist. Same principle as the scanner: absence of a signal is not
 * evidence against.
 */
export function rankResults(parsed: ParsedQuery, cards: CardSearchResult[]): CardSearchResult[] {
  const judged = cards
    .map((c) => judge(parsed, c))
    .filter((r): r is RankedResult => r !== null);

  judged.sort((a, b) => {
    if (a.collectorNumberAgrees !== b.collectorNumberAgrees) return a.collectorNumberAgrees ? -1 : 1;
    if (a.collectorNumberConflicts !== b.collectorNumberConflicts) return a.collectorNumberConflicts ? 1 : -1;
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    // Stable, explainable tiebreak: shorter names are the plainer printing
    // ("Charizard" before "Charizard & Braixen GX"), then alphabetical.
    if (a.card.name.length !== b.card.name.length) return a.card.name.length - b.card.name.length;
    return a.card.name.localeCompare(b.card.name);
  });

  return judged.map((r) => r.card);
}
