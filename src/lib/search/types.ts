// ─── Search Truth Layer — Contract (Phase 5.12A) ─────────────────────────────
// Card databases are SENSORS, exactly like the vision model is a sensor in the
// scanner. A provider that times out has not observed "this card does not
// exist" — it has observed nothing at all. This module encodes that distinction
// so no layer above it can collapse the two.
//
// This generalizes the Phase 5.10 evidence-coverage rule beyond the scanner:
//
//     Unavailable evidence is not a contradiction.
//
// The availability vocabulary below is deliberately parallel to
// EvidenceSignal["availability"] in src/lib/scanner/evidence.ts:
//
//     evidence.ts          search
//     ───────────          ──────
//     "supported"    ↔     "completed"    a reading was produced
//     "unavailable"  ↔     "unavailable"  this source cannot answer this query
//     "failed"       ↔     "failed"       it could have, but didn't this time
//
// The names differ only because "supported" reads oddly for a database call;
// the semantics are identical and intentionally so.

import type { GameId } from "@/lib/scanner/evidence";

// ─── Sources ────────────────────────────────────────────────────────────────

/** Every card database Aura can consult. `local` is the Prisma catalog. */
export type SearchSourceId = "local" | "scryfall" | "pokemon" | "ygoprodeck";

/** Human-facing source names. The UI must never invent its own spellings. */
export const SOURCE_LABELS: Record<SearchSourceId, string> = {
  local: "Local database",
  scryfall: "Scryfall (MTG)",
  pokemon: "Pokémon TCG API",
  ygoprodeck: "YGOPRODeck (Yu-Gi-Oh!)",
};

/**
 * Why a source produced no reading. Kept coarse and closed: this is shown to
 * collectors, so it must be truthful and finite — never a raw upstream string.
 */
export type SourceFailureReason =
  | "timeout"        // upstream exceeded our per-request ceiling
  | "rate_limited"   // upstream refused us (429)
  | "http_error"     // upstream answered, but not with an answer
  | "network"        // we never reached it
  | "not_configured" // we lack the credentials to ask
  | "unexpected";    // anything else — still a failure, never a zero

/**
 * Availability of ONE source for ONE query.
 *
 * - "completed":   we asked and it answered. `resultCount` is then TRUSTWORTHY,
 *                  including when it is 0 — that is a real "no such card here".
 * - "unavailable": we did not ask (a game filter excludes it, or it holds no
 *                  cards for this game). Not a failure; simply out of scope.
 * - "failed":      we asked and did not get an answer. `resultCount` is 0 but
 *                  means NOTHING. This is the case the old code silently
 *                  rendered as "No cards found".
 */
export type SourceAvailability = "completed" | "unavailable" | "failed";

export interface SearchSourceStatus {
  source: SearchSourceId;
  label: string;
  availability: SourceAvailability;
  /** Set only when availability is "failed". */
  reason?: SourceFailureReason;
  /** Cards this source contributed. Meaningful ONLY when "completed". */
  resultCount: number;
  /** Wall-clock time we spent on this source; drives Track B measurement. */
  durationMs: number;
}

// ─── Normalized card shape ──────────────────────────────────────────────────

export interface CardArtwork {
  imageUrl: string | null;
  thumbnailUrl: string | null;
}

export interface CardSetRef {
  name: string;
  /** Printed set code where the source exposes one; null when it does not. */
  code: string | null;
  /**
   * Cards printed in this set — the "165" a collector reads in "006/165".
   *
   * Null means the source never told us, NOT that the set has no size. Ranking
   * must treat null as "cannot corroborate" and never as "conflicts". Today only
   * the Pokémon TCG API exposes this; Scryfall and YGOPRODeck leave it null.
   */
  printedSize: number | null;
}

/**
 * Provenance and everything not part of card identity. Callers that need to
 * know where a result came from look HERE — never by sniffing id formats.
 */
export interface CardSearchMetadata {
  source: SearchSourceId;
  /** The source's own id. Null for local rows that were never linked upstream. */
  externalId: string | null;
  /** Prisma Card.id when this result is already in our catalog. */
  localId: string | null;
  /** Null when the source quoted no price — distinct from a genuine $0.00. */
  marketPrice: number | null;
}

/**
 * The ONLY card shape above the provider boundary. Nothing upstream of
 * CardSearchService may see a Scryfall/Pokemon/YGO payload.
 */
export interface CardSearchResult {
  /** Stable cross-source identity — see cardIdentity() in identity.ts. */
  id: string;
  game: GameId;
  name: string;
  set: CardSetRef;
  collectorNumber: string | null;
  rarity: string;
  artwork: CardArtwork;
  metadata: CardSearchMetadata;
}

// ─── Outcome ────────────────────────────────────────────────────────────────

/**
 * The result of a search, as a TRUTH CLAIM rather than a list.
 *
 * The distinction between `no_matches` and `provider_unavailable` is the whole
 * point of this layer: only `no_matches` asserts that the card was not found.
 * `provider_unavailable` asserts that we do not know.
 */
export type SearchOutcome =
  | {
      status: "results";
      cards: CardSearchResult[];
      sources: SearchSourceStatus[];
    }
  | {
      status: "no_matches";
      cards: [];
      sources: SearchSourceStatus[];
    }
  | {
      status: "provider_unavailable";
      cards: [];
      sources: SearchSourceStatus[];
      /** Labels of the sources that failed, for a UI that must not guess. */
      unavailable: string[];
    };

/**
 * Turn per-source readings into a truth claim. This is the deterministic judge
 * of the search layer — the single place allowed to conclude "not found".
 *
 * The rule, stated exactly:
 *
 *   A query is "no_matches" ONLY when every source we consulted completed
 *   successfully and returned zero cards. If any source failed, we do not
 *   know whether the card exists, and we must say so.
 *
 * Note the asymmetry: found cards outrank failures ("results" wins even if a
 * source failed, with the failure still reported in `sources`), because cards
 * we HAVE are positive evidence. Zero cards never outranks a failure, because
 * zero-from-a-failed-source is not evidence at all.
 */
export function classifyOutcome(
  cards: CardSearchResult[],
  sources: SearchSourceStatus[],
): SearchOutcome {
  if (cards.length > 0) {
    return { status: "results", cards, sources };
  }

  const failed = sources.filter((s) => s.availability === "failed");
  if (failed.length > 0) {
    return {
      status: "provider_unavailable",
      cards: [],
      sources,
      unavailable: failed.map((s) => s.label),
    };
  }

  // Every consulted source completed and found nothing. Only now may we say so.
  return { status: "no_matches", cards: [], sources };
}
