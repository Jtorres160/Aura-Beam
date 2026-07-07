import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

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
    const recentScans = await prisma.scanHistory.findMany({
      where: { userId },
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

    // 4. Generate Price Movers from Collection (Mocked trends for top valuable cards)
    let priceMovers: any[] = [];
    if (collection && collection.cards) {
      // Sort by value
      const valuableCards = [...collection.cards]
        .filter(c => (c.card.prices?.marketPrice || 0) > 0)
        .sort((a, b) => (b.card.prices?.marketPrice || 0) - (a.card.prices?.marketPrice || 0))
        .slice(0, 4);

      priceMovers = valuableCards.map(c => {
        const price = c.card.prices?.marketPrice || 0;
        // Pseudo-random trend based on card ID
        const isUp = c.card.id.charCodeAt(0) % 2 === 0;
        const changePct = ((c.card.id.charCodeAt(1) % 15) + 1.2).toFixed(1);
        const changeAmt = (price * (parseFloat(changePct) / 100)).toFixed(2);
        
        return {
          name: c.card.name,
          game: c.card.game,
          trend: isUp ? "up" : "down",
          percent: `${isUp ? "+" : "-"}${changePct}%`,
          change: `${isUp ? "+" : "-"}$${changeAmt}`,
        };
      });
    }

    // 5. Generate Synthetic Portfolio History (30 Days)
    // We start from 30 days ago and generate realistic deterministic fluctuations ending at `totalValue` today.
    const portfolioHistory = [];
    if (totalValue > 0) {
      // Assume about 15% growth over the last 30 days
      let simulatedValue = totalValue * 0.85; 
      const now = new Date();
      for (let i = 30; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        
        if (i < 30 && i > 0) {
           // Deterministic noise using Math.sin
           const pseudoRandom = Math.sin(i * 12.345) * 0.02; // ±2%
           // Slight upward bias
           simulatedValue = simulatedValue * (1 + 0.005 + pseudoRandom);
        } else if (i === 0) {
           simulatedValue = totalValue; // Ensure today's exact value
        }
        
        portfolioHistory.push({
          date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          value: parseFloat(simulatedValue.toFixed(2))
        });
      }
    } else {
      const now = new Date();
      for (let i = 30; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        portfolioHistory.push({
          date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          value: 0
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        stats: {
          collectionValue: totalValue,
          cardsOwned: totalCards,
        },
        recentScans: formattedScans,
        priceMovers: priceMovers,
        portfolioHistory: portfolioHistory,
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
