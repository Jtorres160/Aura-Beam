// ═══════════════════════════════════════════════════════════
// Aura — Shared Card Contracts (Phase 3 · T1)
// ═══════════════════════════════════════════════════════════
// Explicit client-side mirrors of the server card contracts, so the surfaces
// that consume scan/save responses stop treating them as `any`. These describe
// EXISTING server behavior only — they must not add or redesign fields:
//
//   SavedCard              → serializeSavedCard()  (src/lib/cards/serialize-card.ts)
//   DisambiguationCandidate → disambiguationResponse() (src/app/api/scanner/scan/route.ts)
//   PostAddArchive         → collections/add + collections/add/bulk archive delta
//
// GameId / PrintingPrice / ArchiveContext are re-used from their authoritative
// definitions (type-only imports, erased at build time) rather than redefined.

import type { GameId, PrintingPrice } from "@/lib/scanner/evidence";
import type { ArchiveContext } from "@/types";

/**
 * Price block on a saved card. serializeSavedCard() coerces every tier to a
 * number (falling back to 0), so unlike the source PrintingPrice these are all
 * required numbers — never null/undefined.
 */
export interface SavedCardPrices {
  marketPrice: number;
  lowPrice: number;
  midPrice: number;
  highPrice: number;
}

/**
 * The object returned under `data` after a card is saved — by BOTH the scan
 * auto-accept path and the disambiguation save-selection path. Mirrors
 * serializeSavedCard(); `game`/`rarity`/image fields reflect the persisted
 * Prisma Card row (game is a plain string; images may be null).
 */
export interface SavedCard {
  id: string;
  name: string;
  /** Set NAME (serialized as `set`, from Card.setName). */
  set: string;
  game: string;
  /** What this card means in the user's archive; null when lookup was unavailable. */
  archive: ArchiveContext | null;
  prices: SavedCardPrices;
  rarity: string;
  confidence: number;
  /** Only the auto-accept path reports a match method; absent on user-selection saves. */
  method?: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  historyId: string;
}

/**
 * One unresolved printing choice in the disambiguation grid. Mirrors the mapped
 * shape from disambiguationResponse() — a projection of CandidatePrinting plus
 * the `isBestMatch` flag the UI highlights.
 */
export interface DisambiguationCandidate {
  externalId: string;
  name: string;
  game: GameId;
  setName: string;
  setCode: string | null;
  collectorNumber: string | null;
  rarity: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  price: PrintingPrice;
  /** Vision's best guess — highlighted at the top of the grid. */
  isBestMatch: boolean;
}

/**
 * Archive totals returned alongside a collection add. Single-add reports
 * `quantity`; bulk-add reports `added`. Null on the client when the (failure-safe)
 * server aggregation was unavailable.
 */
export interface PostAddArchive {
  totalCards: number;
  quantity?: number;
  added?: number;
}
