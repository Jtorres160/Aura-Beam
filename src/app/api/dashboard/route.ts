import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { startOfUtcDay } from "@/lib/rate-limit";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // 1. Fetch Primary Collection Data
    const collection = await prisma.collection.findFirst({
      where: { userId },
      include: {
        cards: {
          include: {
            card: {
              include: { prices: true },
            },
          },
        },
      },
    });

    let totalValue = 0;
    let totalCards = 0;

    if (collection && collection.cards) {
      for (const cCard of collection.cards) {
        totalCards += cCard.quantity;
        const marketPrice = cCard.card.prices?.marketPrice || 0;
        totalValue += marketPrice * cCard.quantity;
      }
    }

    // 2. Fetch Recent Scans
    // cardId != null: telemetry rows for disambiguation/not-found attempts
    // have no card and would render as "Unknown Card" here.
    const recentScans = await prisma.scanHistory.findMany({
      where: { userId, cardId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        card: {
          include: { prices: true },
        },
      },
    });

    // 3. Format Recent Scans for Frontend
    const formattedScans = recentScans.map((scan) => ({
      id: scan.id,
      name: scan.card?.name || "Unknown Card",
      set: scan.card?.setName || "Unknown Set",
      game: scan.card?.game || "Unknown",
      price: scan.card?.prices?.marketPrice || 0,
      imageUrl: scan.card?.imageUrl || scan.card?.thumbnailUrl || null,
      confidence: scan.confidence ? `${scan.confidence}%` : "100%",
      createdAt: scan.createdAt,
    }));

    // 4. Real Price Movers — computed ONLY from recorded PriceHistory.
    // A card can only "move" if Aura has stored at least two price points for
    // it (the price-update cron records these). Cards without history are not
    // shown at all — we never invent a trend. If nothing has moved, the client
    // renders an honest empty state.
    let priceMovers: any[] = [];
    if (collection && collection.cards && collection.cards.length > 0) {
      const ownedCardIds = collection.cards.map((c) => c.card.id);

      // Pull recent history for owned cards; newest first so the first two rows
      // per card are the latest and its immediate predecessor.
      const history = await prisma.priceHistory.findMany({
        where: { cardId: { in: ownedCardIds }, marketPrice: { not: null } },
        orderBy: { recordedAt: "desc" },
        select: { cardId: true, marketPrice: true, recordedAt: true },
      });

      const latestTwoByCard = new Map<string, { marketPrice: number }[]>();
      for (const row of history) {
        const list = latestTwoByCard.get(row.cardId) ?? [];
        if (list.length < 2) {
          list.push({ marketPrice: row.marketPrice as number });
          latestTwoByCard.set(row.cardId, list);
        }
      }

      const cardById = new Map(collection.cards.map((c) => [c.card.id, c.card]));
      const movers = [];
      for (const [cardId, points] of latestTwoByCard) {
        if (points.length < 2) continue; // needs a prior price to have moved
        const current = points[0].marketPrice;
        const previous = points[1].marketPrice;
        if (!previous || previous === 0 || current === previous) continue;
        const card = cardById.get(cardId);
        if (!card) continue;

        const changeAmt = current - previous;
        const changePct = (changeAmt / previous) * 100;
        const up = changeAmt > 0;
        movers.push({
          name: card.name,
          game: card.game,
          trend: up ? "up" : "down",
          percent: `${up ? "+" : "-"}${Math.abs(changePct).toFixed(1)}%`,
          change: `${up ? "+" : "-"}$${Math.abs(changeAmt).toFixed(2)}`,
          _abs: Math.abs(changePct),
        });
      }

      // Biggest absolute movers first; drop the internal sort key.
      priceMovers = movers
        .sort((a, b) => b._abs - a._abs)
        .slice(0, 4)
        .map(({ _abs, ...m }) => m);
    }

    // 5. Portfolio history — real recorded snapshots only.
    // We opportunistically record ONE snapshot of the true collection value per
    // UTC day when the user opens Insights, so history accrues from genuine use
    // even without a scheduled cron. The chart is drawn strictly from these
    // stored points; until two days exist the client shows "building history".
    // All snapshot access is guarded so a not-yet-migrated table degrades to the
    // building-history state instead of failing the request.
    let portfolioHistory: { date: string; value: number }[] = [];
    let portfolioStatus: "building" | "ready" = "building";
    let weeklyChange: { amount: number; percent: number } | null = null;

    try {
      const todayStart = startOfUtcDay();
      const existingToday = await prisma.portfolioSnapshot.findFirst({
        where: { userId, recordedAt: { gte: todayStart } },
      });
      if (existingToday) {
        await prisma.portfolioSnapshot.update({
          where: { id: existingToday.id },
          data: { totalValue, cardCount: totalCards, recordedAt: new Date() },
        });
      } else {
        await prisma.portfolioSnapshot.create({
          data: { userId, totalValue, cardCount: totalCards },
        });
      }

      const snapshots = await prisma.portfolioSnapshot.findMany({
        where: { userId },
        orderBy: { recordedAt: "asc" },
        take: 90,
      });

      portfolioHistory = snapshots.map((s) => ({
        date: s.recordedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        value: parseFloat(s.totalValue.toFixed(2)),
      }));

      // A trend needs at least two distinct days of real data.
      if (snapshots.length >= 2) {
        portfolioStatus = "ready";
        const latest = snapshots[snapshots.length - 1];
        const weekAgoCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        // The oldest snapshot within the last 7 days, else the earliest we have.
        const baseline =
          [...snapshots].find((s) => s.recordedAt >= weekAgoCutoff) ?? snapshots[0];
        if (baseline.id !== latest.id && baseline.totalValue > 0) {
          const amount = latest.totalValue - baseline.totalValue;
          weeklyChange = {
            amount: parseFloat(amount.toFixed(2)),
            percent: parseFloat(((amount / baseline.totalValue) * 100).toFixed(1)),
          };
        }
      }
    } catch (err) {
      // Table not migrated yet, or a transient DB issue — fall back to the
      // honest building-history state rather than surfacing an error.
      console.warn("[Dashboard] Portfolio snapshot unavailable:", (err as Error)?.message);
      portfolioHistory = [];
      portfolioStatus = "building";
      weeklyChange = null;
    }

    return NextResponse.json({
      success: true,
      data: {
        stats: {
          collectionValue: totalValue,
          cardsOwned: totalCards,
        },
        recentScans: formattedScans,
        priceMovers,
        portfolioHistory,
        portfolioStatus,
        weeklyChange,
      },
    });
  } catch (error) {
    console.error("Dashboard Fetch Error:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch dashboard data" },
      { status: 500 }
    );
  }
}
