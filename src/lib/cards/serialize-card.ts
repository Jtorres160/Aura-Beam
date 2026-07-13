import type { Card } from "@prisma/client";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import type { ArchiveContext } from "@/lib/scanner/archive-context";

// ─── Shared saved-card serialization (Phase 2 · C4) ─────────────────────────
// Builds the `data` payload both save paths return, so a response-field
// change happens once. Prices come from the authoritative printing (not the
// stored row) to mirror the freshly-upserted CardPrice.

export interface SerializeSavedCardInput {
  localCard: Card;
  printing: CandidatePrinting;
  archive: ArchiveContext | null;
  confidence: number;
  historyId: string;
  // Only the auto-accept path reports a match method. Omit the key entirely on
  // the user-selection path — it never carried a `method` field.
  method?: string | null;
}

export function serializeSavedCard(input: SerializeSavedCardInput) {
  const { localCard, printing, archive, confidence, historyId } = input;
  return {
    id: localCard.id,
    name: localCard.name,
    set: localCard.setName,
    game: localCard.game,
    archive,
    prices: {
      marketPrice: printing.price?.marketPrice || 0,
      lowPrice: printing.price?.lowPrice || 0,
      midPrice: printing.price?.midPrice || 0,
      highPrice: printing.price?.highPrice || 0,
    },
    rarity: localCard.rarity,
    confidence,
    ...("method" in input ? { method: input.method } : {}),
    imageUrl: localCard.imageUrl,
    thumbnailUrl: localCard.thumbnailUrl,
    historyId,
  };
}
