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

    if (existingEntry) {
      const updated = await prisma.collectionCard.update({
        where: { id: existingEntry.id },
        data: { quantity: existingEntry.quantity + 1 },
      });
      return NextResponse.json({ success: true, data: updated, message: "Card quantity updated" }, { status: 201 });
    } else {
      const added = await prisma.collectionCard.create({
        data: {
          collectionId: collection.id,
          cardId: localCardId,
          quantity: 1,
        },
      });
      return NextResponse.json({ success: true, data: added, message: "Card added to collection" }, { status: 201 });
    }
  } catch (error) {
    console.error("Error adding card to collection:", error);
    return NextResponse.json(
      { success: false, message: "Failed to add card to collection" },
      { status: 500 }
    );
  }
}
