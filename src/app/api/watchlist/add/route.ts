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

    // 1. Smart Upsert Card Logic
    let card = await prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      // It's a live API card, let's fetch it and insert it locally
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

      await prisma.cardPrice.create({
        data: {
          cardId: card.id,
          marketPrice: formatted.price.marketPrice,
        },
      });
    }

    const localCardId = card.id;

    // 2. Add to Watchlist
    const existingEntry = await prisma.watchlist.findUnique({
      where: {
        userId_cardId: {
          userId,
          cardId: localCardId,
        },
      },
    });

    if (existingEntry) {
      return NextResponse.json({ success: true, message: "Card is already on your watchlist" });
    }

    const added = await prisma.watchlist.create({
      data: {
        userId,
        cardId: localCardId,
      },
    });

    return NextResponse.json({ success: true, data: added, message: "Card added to watchlist" }, { status: 201 });
  } catch (error) {
    console.error("Error adding to watchlist:", error);
    return NextResponse.json(
      { success: false, message: "Failed to add to watchlist" },
      { status: 500 }
    );
  }
}
