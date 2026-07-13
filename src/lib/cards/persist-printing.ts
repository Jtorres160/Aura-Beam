import type { Card } from "@prisma/client";
import { dbRetry, prisma } from "@/lib/prisma";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

// ─── Shared printing persistence (Phase 2 · C4) ─────────────────────────────
// The single place that writes a scanned/selected printing into the GLOBAL
// Card + CardPrice tables. Both save paths (scan auto-accept and
// disambiguation selection) funnel through here so a future schema or pricing
// change happens once instead of twice.
//
// Operates on normalized printing data only — no game-specific branching. The
// caller is responsible for producing an authoritative CandidatePrinting
// (re-fetched from the source card database), never request-supplied data.
export async function persistPrinting(printing: CandidatePrinting): Promise<Card> {
  // Atomic upsert on the unique externalId (no findFirst→create race); the
  // update branch refreshes metadata from the card database, so stale
  // names/images self-heal on a re-scan.
  const cardData = {
    name: printing.name,
    setName: printing.setName,
    setCode: printing.setCode || null,
    collectorNumber: printing.collectorNumber || null,
    rarity: printing.rarity,
    imageUrl: printing.imageUrl,
    thumbnailUrl: printing.thumbnailUrl,
  };
  const localCard = await dbRetry(() => prisma.card.upsert({
    where: { externalId: printing.externalId },
    update: cardData,
    create: {
      externalId: printing.externalId,
      game: printing.game,
      ...cardData,
    },
  }));

  // Always refresh the stored price with what the card database returned just
  // now — a card first scanned months ago must not keep its stale price.
  await dbRetry(() => prisma.cardPrice.upsert({
    where: { cardId: localCard.id },
    update: {
      marketPrice: printing.price?.marketPrice || 0,
      lowPrice: printing.price?.lowPrice || null,
      midPrice: printing.price?.midPrice || null,
      highPrice: printing.price?.highPrice || null,
      lastUpdated: new Date(),
    },
    create: {
      cardId: localCard.id,
      marketPrice: printing.price?.marketPrice || 0,
      lowPrice: printing.price?.lowPrice || null,
      midPrice: printing.price?.midPrice || null,
      highPrice: printing.price?.highPrice || null,
    },
  }));

  return localCard;
}
