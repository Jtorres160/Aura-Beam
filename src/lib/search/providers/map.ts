// ─── Provider → normalized shape (Phase 5.12A) ──────────────────────────────
// The existing services already normalize each upstream payload into a
// CandidatePrinting (formatScryfallCard / formatPokemonCard / formatYugiohCard).
// That normalization is reused verbatim rather than rewritten — it is the same
// mapping the scanner trusts, and two mappings would eventually disagree about
// the same card.
//
// This module only widens CandidatePrinting into the search-facing shape.

import type { CandidatePrinting } from "@/lib/scanner/evidence";
import type { CardSearchResult, SearchSourceId } from "@/lib/search/types";

/**
 * Widen a CandidatePrinting into a CardSearchResult.
 *
 * `marketPrice` is null — not 0 — when a source quotes no price. A card with an
 * unknown price is not a card worth $0.00, and the UI must be able to say so.
 * The old route coerced every missing price to 0 and rendered "$0.00" as fact.
 */
export function fromCandidatePrinting(
  printing: CandidatePrinting,
  source: SearchSourceId,
  localId: string | null = null,
): CardSearchResult {
  const rawPrice = printing.price?.marketPrice;
  const marketPrice = typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : null;

  const card: CardSearchResult = {
    // ROUTABLE id — what /cards/[id] resolves. Distinct from cardIdentity(),
    // which exists only to merge duplicates and is never used as a URL.
    id: printing.externalId,
    game: printing.game,
    name: printing.name,
    set: {
      name: printing.setName || "Unknown Set",
      code: printing.setCode ?? null,
    },
    collectorNumber: printing.collectorNumber ?? null,
    rarity: printing.rarity || "Unknown",
    artwork: {
      imageUrl: printing.imageUrl ?? null,
      thumbnailUrl: printing.thumbnailUrl ?? printing.imageUrl ?? null,
    },
    metadata: {
      source,
      externalId: printing.externalId ?? null,
      localId,
      marketPrice,
    },
  };

  return card;
}
