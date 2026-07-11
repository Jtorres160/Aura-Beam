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

    // 1. Build the set of cards worth refreshing: everything any user OWNS
    // (so collection value stays true and PriceHistory accrues for the movers
    // + portfolio chart) UNION everything under an active price alert. Owned
    // cards were previously never refreshed after scan time — that was the
    // root cause of stale collection values.
    const [ownedCardLinks, activeWatchlists] = await Promise.all([
      prisma.collectionCard.findMany({
        distinct: ["cardId"],
        select: { card: { select: { id: true, externalId: true, game: true } } },
      }),
      prisma.watchlist.findMany({
        where: {
          alertEnabled: true,
          OR: [{ alertAbove: { not: null } }, { alertBelow: { not: null } }],
        },
        include: { card: true, user: true },
      }),
    ]);

    // Alerts to evaluate, grouped by card.
    const watchlistsByCard = activeWatchlists.reduce((acc, watchlist) => {
      (acc[watchlist.cardId] ??= []).push(watchlist);
      return acc;
    }, {} as Record<string, typeof activeWatchlists>);

    // Union of card records to refresh, de-duplicated by id.
    const cardsById = new Map<string, { id: string; externalId: string | null; game: string }>();
    for (const link of ownedCardLinks) {
      if (link.card) cardsById.set(link.card.id, link.card);
    }
    for (const w of activeWatchlists) {
      cardsById.set(w.card.id, { id: w.card.id, externalId: w.card.externalId, game: w.card.game });
    }

    if (cardsById.size === 0) {
      return NextResponse.json({ success: true, message: "No owned or watched cards to process." });
    }

    // 2. Prioritize the stalest prices so repeated runs make steady progress
    // and one run never fans out to an unbounded number of external calls.
    const MAX_CARDS_PER_RUN = 250;
    const priceRows = await prisma.cardPrice.findMany({
      where: { cardId: { in: Array.from(cardsById.keys()) } },
      select: { cardId: true, lastUpdated: true },
    });
    const lastUpdatedByCard = new Map(priceRows.map((p) => [p.cardId, p.lastUpdated]));

    const orderedCards = Array.from(cardsById.values())
      .filter((c) => c.externalId)
      .sort((a, b) => {
        // Never-priced cards first, then oldest lastUpdated first.
        const ta = lastUpdatedByCard.get(a.id)?.getTime() ?? 0;
        const tb = lastUpdatedByCard.get(b.id)?.getTime() ?? 0;
        return ta - tb;
      })
      .slice(0, MAX_CARDS_PER_RUN);

    let updatedCount = 0;
    let alertsTriggered = 0;

    // 3. Iterate through each unique card and fetch its latest price
    for (const card of orderedCards) {
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

      if (!newPriceData || newPriceData.marketPrice === undefined || newPriceData.marketPrice === null) continue;

      const newMarketPrice = newPriceData.marketPrice;

      // Update the CardPrice in our database
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

      // Record in price history — this is what powers real price movers.
      await prisma.priceHistory.create({
        data: {
          cardId: card.id,
          marketPrice: newMarketPrice,
        }
      });

      updatedCount++;

      // 4. Check alerts for each user watching this card
      const watchlists = watchlistsByCard[card.id] ?? [];
      for (const watchlist of watchlists) {
        let triggered = false;
        let alertMessage = "";

        if (watchlist.alertAbove && newMarketPrice >= watchlist.alertAbove) {
          triggered = true;
          alertMessage = `${watchlist.card.name} has risen above $${watchlist.alertAbove.toFixed(2)}! Current price: $${newMarketPrice.toFixed(2)}`;
        } else if (watchlist.alertBelow && newMarketPrice <= watchlist.alertBelow) {
          triggered = true;
          alertMessage = `${watchlist.card.name} has dropped below $${watchlist.alertBelow.toFixed(2)}! Current price: $${newMarketPrice.toFixed(2)}`;
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
