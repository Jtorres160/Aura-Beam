import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPokemonCardById, formatPokemonCard } from "@/lib/services/pokemon";
import { getScryfallCardById, formatScryfallCard } from "@/lib/services/scryfall";
import { getYugiohCardById, formatYugiohCard } from "@/lib/services/yugioh";

// This endpoint is meant to be called by a cron job (e.g., Vercel Cron)
export async function GET(request: Request) {
  try {
    // Basic security: check for a cron secret if one is configured
    const authHeader = request.headers.get("authorization");
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting price update job...");

    // 1. Find all cards that are actively being watched by users
    // Group by card to avoid duplicate API calls
    const activeWatchlists = await prisma.watchlist.findMany({
      where: {
        alertEnabled: true,
        OR: [
          { alertAbove: { not: null } },
          { alertBelow: { not: null } }
        ]
      },
      include: {
        card: true,
        user: true,
      }
    });

    if (activeWatchlists.length === 0) {
      return NextResponse.json({ success: true, message: "No active price alerts to process." });
    }

    // Group watchlists by card
    const watchlistsByCard = activeWatchlists.reduce((acc, watchlist) => {
      if (!acc[watchlist.cardId]) {
        acc[watchlist.cardId] = [];
      }
      acc[watchlist.cardId].push(watchlist);
      return acc;
    }, {} as Record<string, typeof activeWatchlists>);

    let updatedCount = 0;
    let alertsTriggered = 0;

    // 2. Iterate through each unique card and fetch its latest price
    for (const cardId in watchlistsByCard) {
      const watchlists = watchlistsByCard[cardId];
      const card = watchlists[0].card;
      
      if (!card.externalId) continue;

      let newPriceData = null;

      try {
        if (card.game === "Pokemon") {
          const externalCard = await getPokemonCardById(card.externalId);
          if (externalCard) newPriceData = formatPokemonCard(externalCard).price;
        } else if (card.game === "MTG") {
          const externalCard = await getScryfallCardById(card.externalId);
          if (externalCard) newPriceData = formatScryfallCard(externalCard).price;
        } else if (card.game === "YUGIOH" || card.game === "Yugioh") {
          const externalCard = await getYugiohCardById(card.externalId);
          if (externalCard) newPriceData = formatYugiohCard(externalCard).price;
        }
      } catch (err) {
        console.error(`[CRON] Failed to fetch external price for card ${card.id}:`, err);
        continue;
      }

      if (!newPriceData || newPriceData.marketPrice === undefined) continue;

      const newMarketPrice = newPriceData.marketPrice;

      // 3. Update the CardPrice in our database
      await prisma.cardPrice.upsert({
        where: { cardId: card.id },
        update: {
          marketPrice: newMarketPrice,
          lastUpdated: new Date(),
        },
        create: {
          cardId: card.id,
          marketPrice: newMarketPrice,
        }
      });
      
      // Also record in price history
      await prisma.priceHistory.create({
        data: {
          cardId: card.id,
          marketPrice: newMarketPrice,
        }
      });
      
      updatedCount++;

      // 4. Check alerts for each user watching this card
      for (const watchlist of watchlists) {
        let triggered = false;
        let alertMessage = "";

        if (watchlist.alertAbove && newMarketPrice >= watchlist.alertAbove) {
          triggered = true;
          alertMessage = `${card.name} has risen above $${watchlist.alertAbove.toFixed(2)}! Current price: $${newMarketPrice.toFixed(2)}`;
        } else if (watchlist.alertBelow && newMarketPrice <= watchlist.alertBelow) {
          triggered = true;
          alertMessage = `${card.name} has dropped below $${watchlist.alertBelow.toFixed(2)}! Current price: $${newMarketPrice.toFixed(2)}`;
        }

        if (triggered) {
          // Create Notification
          await prisma.notification.create({
            data: {
              userId: watchlist.userId,
              title: "Price Alert Triggered",
              message: alertMessage,
              type: "price_alert",
              data: JSON.stringify({ cardId: card.id, newPrice: newMarketPrice }),
            }
          });

          // Disable the alert so it doesn't fire endlessly
          await prisma.watchlist.update({
            where: { id: watchlist.id },
            data: { alertEnabled: false }
          });
          
          alertsTriggered++;
        }
      }
    }

    console.log(`[CRON] Job complete. Cards updated: ${updatedCount}. Alerts triggered: ${alertsTriggered}.`);

    return NextResponse.json({
      success: true,
      message: `Successfully processed prices for ${updatedCount} cards. Triggered ${alertsTriggered} alerts.`,
      updatedCount,
      alertsTriggered
    });

  } catch (error) {
    console.error("[CRON] Error during price update:", error);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
