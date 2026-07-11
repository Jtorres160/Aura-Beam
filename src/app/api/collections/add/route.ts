import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { getPokemonCardById, formatPokemonCard } from "@/lib/services/pokemon";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const { cardId } = body;

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

    // 2. Verify card exists locally OR fetch and insert from API
    let card = await prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      // It's a live API card, let's fetch it and insert it locally!
      // (Assume Pokemon for now based on original logic, but ideally we check prefix)
      const externalCard = await getPokemonCardById(cardId);
      if (!externalCard) {
        return NextResponse.json({ success: false, message: "Card not found in local DB or external API" }, { status: 404 });
      }

      const formatted = formatPokemonCard(externalCard);
      card = await prisma.card.create({
        data: {
          externalId: formatted.externalId,
          name: formatted.name,
          game: formatted.game,
          setName: formatted.setName,
          rarity: formatted.rarity,
          imageUrl: formatted.imageUrl,
          thumbnailUrl: formatted.thumbnailUrl,
        },
      });

      // Insert prices too
      await prisma.cardPrice.create({
        data: {
          cardId: card.id,
          marketPrice: formatted.price.marketPrice,
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
