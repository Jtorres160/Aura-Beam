import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { fetchPrintingById, fetchPrintingByIdAcrossGames } from "@/lib/scanner/candidates";
import { messageForUnavailableAdd } from "@/lib/scanner/failure";

/**
 * Resolve an external card reference to a normalized printing. If the caller
 * named the game we go straight to its source; otherwise we probe each in turn.
 *
 * Both branches return a truth claim rather than a nullable card (Phase
 * 5.13C) — the judgement about what a silent provider means belongs to the
 * candidate layer, not to a route.
 */
async function resolvePrinting(externalId: string, game?: string) {
  return game
    ? await fetchPrintingById(game, externalId)
    : await fetchPrintingByIdAcrossGames(externalId);
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
      const lookup = await resolvePrinting(cardId, game);

      // Phase 5.13C: a source that went quiet gets a 503, not the 404 that
      // asserts the card isn't real. We didn't fail to find it; we failed to ask.
      if (lookup.status === "provider_unavailable") {
        console.warn(
          `[Collections] ⚠ Cannot add ${cardId} — ${lookup.label} unavailable (${lookup.reason})`
        );
        return NextResponse.json(
          {
            success: false,
            stage: "provider-unavailable",
            message: messageForUnavailableAdd([lookup.label]),
            unavailableSources: [lookup.label],
          },
          { status: 503 }
        );
      }

      if (lookup.status === "not_found") {
        return NextResponse.json({ success: false, message: "Card not found in local DB or external API" }, { status: 404 });
      }

      const printing = lookup.card;

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
