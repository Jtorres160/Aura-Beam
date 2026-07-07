import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPokemonCardById, formatPokemonCard } from "@/lib/services/pokemon";
import { getScryfallCardById, formatScryfallCard } from "@/lib/services/scryfall";
import { getYugiohCardById, formatYugiohCard } from "@/lib/services/yugioh";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // 1. Try to find the card in our local database first (by ID or externalId)
    const localCard = await prisma.card.findFirst({
      where: {
        OR: [
          { id: id },
          { externalId: id }
        ]
      },
      include: {
        prices: true
      }
    });

    if (localCard) {
      return NextResponse.json({ success: true, data: localCard });
    }

    // 2. If not found locally, fetch from external APIs in parallel
    // Since we don't know the game, we query all three. They usually have distinct ID formats.
    const promises = [
      getPokemonCardById(id).then(data => data ? formatPokemonCard(data) : null),
      getScryfallCardById(id).then(data => data ? formatScryfallCard(data) : null),
      getYugiohCardById(id).then(data => data ? formatYugiohCard(data) : null)
    ];

    const results = await Promise.allSettled(promises);
    
    console.log("External APIs results:", results);

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        // We found a match in one of the APIs!
        const cardData = result.value;
        // Mock the structure to match our DB for the frontend
        return NextResponse.json({ 
          success: true, 
          data: {
            id: cardData.externalId,
            ...cardData,
            prices: cardData.price
          } 
        });
      }
    }

    // 3. Not found anywhere
    return NextResponse.json({ success: false, message: "Card not found" }, { status: 404 });

  } catch (error) {
    console.error("Error fetching card details:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch card details" },
      { status: 500 }
    );
  }
}
