import type { Card } from "@prisma/client";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import type { ArchiveContext } from "@/lib/scanner/archive-context";
import type { SavedCard } from "@/types/card";

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

export function serializeSavedCard(input: SerializeSavedCardInput): SavedCard {
  const { localCard, printing, archive, confidence, historyId } = input;
  return {
    id: localCard.id,
    name: localCard.name,
    set: localCard.setName,
    game: localCard.game,
    archive,
    prices: {
      // marketPrice passes absence through as null — a scan of an unpriced card
      // must not report "$0.00" to the client. The tier fields keep their 0
      // default: no source populates them, so they carry no information either
      // way and nothing renders them.
      marketPrice: printing.price?.marketPrice ?? null,
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
    // Reveal accent evidence, taken from the PRINTING rather than the stored row
    // — same reason prices are: the printing is the authoritative resolution, and
    // Card has no clean column for either field (its `types` is a mixed
    // "Fire,Stage 2" string, populated on 0 of 157 rows). Both keys are omitted
    // entirely when the source did not carry the field, so a consumer can tell
    // "colorless" (`[]`) apart from "unknown" (absent).
    ...(printing.colorIdentity ? { colorIdentity: printing.colorIdentity } : {}),
    ...(printing.types ? { types: printing.types } : {}),
  };
}
