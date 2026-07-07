import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchPokemonCards, formatPokemonCard } from "@/lib/services/pokemon";
import { searchScryfallCards, formatScryfallCard } from "@/lib/services/scryfall";
import { searchYugiohCards, formatYugiohCard } from "@/lib/services/yugioh";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const game = searchParams.get("game");
    const q = searchParams.get("q");

    const where: any = {};
    if (game) {
      where.game = game.toUpperCase();
    }
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { setName: { contains: q } },
      ];
    }

    const localCards = await prisma.card.findMany({
      where,
      include: {
        prices: true,
      },
      orderBy: {
        name: "asc",
      },
      take: 20, // limit local results
    });

    let liveCards: any[] = [];
    
    if (q) {
      const promises: Promise<any[]>[] = [];
      const gameUpper = game?.toUpperCase();

      // Dispatch to the correct API based on the selected game (or all if no game is specified)
      if (!gameUpper || gameUpper === "POKEMON") {
        promises.push(
          searchPokemonCards(q).then((results) => 
            results.map((apiCard: any) => formatPokemonCard(apiCard))
          )
        );
      }
      
      if (!gameUpper || gameUpper === "MTG") {
        promises.push(
          searchScryfallCards(q).then((results) => 
            results.map((apiCard: any) => formatScryfallCard(apiCard))
          )
        );
      }
      
      if (!gameUpper || gameUpper === "YUGIOH") {
        promises.push(
          searchYugiohCards(q).then((results) => 
            results.map((apiCard: any) => formatYugiohCard(apiCard))
          )
        );
      }

      // Execute all selected API searches in parallel
      const nestedResults = await Promise.all(promises);
      
      // Flatten and map to final format with IDs
      liveCards = nestedResults.flat().map((formatted: any) => ({
        id: formatted.externalId, // Temporarily use externalId as ID for frontend
        ...formatted,
        prices: formatted.price,
      }));
    }

    // Combine and deduplicate
    const combined = [...localCards, ...liveCards];
    const unique = combined.filter((v, i, a) => a.findIndex(t => (t.id === v.id || t.externalId === v.externalId)) === i);
    
    return NextResponse.json({
      success: true,
      data: unique,
    });
  } catch (error) {
    console.error("Error fetching cards:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch cards" },
      { status: 500 }
    );
  }
}
