import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { fetchPrintingById } from "@/lib/scanner/candidates";
import type { CandidatePrinting } from "@/lib/scanner/evidence";

// Games we can authoritatively re-fetch a printing for. Used only as an
// ordered fallback when the client didn't tell us which game the card is —
// e.g. a cached client deployed before `game` was sent with the request.
const SUPPORTED_GAMES = ["MTG", "POKEMON", "YUGIOH"] as const;

// Resolve an external card reference to a normalized printing WITHOUT assuming
// a game. If the caller named the game we go straight to its source; otherwise
// we try each source in turn (reusing the same game-aware fetcher the scanner's
// save-selection path uses — no duplicated per-game fetch logic here).
async function resolvePrinting(externalId: string, game?: string): Promise<CandidatePrinting | null> {
  if (game) {
    return await fetchPrintingById(game, externalId);
  }
  for (const g of SUPPORTED_GAMES) {
    const printing = await fetchPrintingById(g, externalId);
    if (printing) return printing;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const cardId: string | undefined = body?.cardId;
    // Optional — lets us skip straight to the right source instead of probing.
    const game: string | undefined = typeof body?.game === "string" ? body.game : undefined;

    if (!cardId) {
      return NextResponse.json({ success: false, message: "Card ID is required" }, { status: 400 });
    }

    // 1. Get or create primary collection
    let collection = await prisma.collection.findFirst({
      where: { userId },
    });

    if (!collection) {
      collection = await prisma.collection.create({
        data: {
          userId,
          name: "My Core Collection",
        },
      });
    }

    // 2. Verify card exists locally OR fetch and insert from the card's own
    // source database. The lookup is game-agnostic (by local id OR externalId);
    // the external fetch is game-aware via fetchPrintingById, so an MTG or
    // Yu-Gi-Oh card is never mistakenly looked up against the Pokémon API.
    let card = await prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      const printing = await resolvePrinting(cardId, game);
      if (!printing) {
        return NextResponse.json({ success: false, message: "Card not found in local DB or external API" }, { status: 404 });
      }

      card = await prisma.card.create({
        data: {
          externalId: printing.externalId,
          name: printing.name,
          game: printing.game,
          setName: printing.setName,
          rarity: printing.rarity,
          imageUrl: printing.imageUrl,
          thumbnailUrl: printing.thumbnailUrl,
        },
      });

      // Insert prices too
      await prisma.cardPrice.create({
        data: {
          cardId: card.id,
          marketPrice: printing.price?.marketPrice ?? 0,
        },
      });
    }

    // Ensure we use the local DB ID for the collection entry, not the external one
    const localCardId = card.id;

    // 3. Upsert CollectionCard
    const existingEntry = await prisma.collectionCard.findUnique({
      where: {
        collectionId_cardId: {
          collectionId: collection.id,
          cardId: localCardId,
        },
      },
    });

    let entry;
    let message;
    if (existingEntry) {
      entry = await prisma.collectionCard.update({
        where: { id: existingEntry.id },
        data: { quantity: existingEntry.quantity + 1 },
      });
      message = "Card quantity updated";
    } else {
      entry = await prisma.collectionCard.create({
        data: {
          collectionId: collection.id,
          cardId: localCardId,
          quantity: 1,
        },
      });
      message = "Card added to collection";
    }

    // Archive delta (Phase 5 · Batch 2): the new archive totals, so the client
    // can show what this add changed. Failure-safe — totals are additive info
    // and must never fail the add itself.
    let archive = null;
    try {
      const agg = await prisma.collectionCard.aggregate({
        where: { collectionId: collection.id },
        _sum: { quantity: true },
      });
      archive = { totalCards: agg._sum.quantity ?? 0, quantity: entry.quantity };
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({ success: true, data: entry, archive, message }, { status: 201 });
  } catch (error) {
    console.error("Error adding card to collection:", error);
    return NextResponse.json(
      { success: false, message: "Failed to add card to collection" },
      { status: 500 }
    );
  }
}
