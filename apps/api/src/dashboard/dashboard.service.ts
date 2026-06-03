import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboardData(userId: string) {
    // 1. Fetch Primary Collection Data
    const collection = await this.prisma.collection.findFirst({
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
    const recentScans = await this.prisma.scanHistory.findMany({
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
      confidence: scan.confidence ? `${scan.confidence}%` : "100%",
      createdAt: scan.createdAt,
    }));

    return {
      success: true,
      data: {
        stats: {
          collectionValue: totalValue,
          cardsOwned: totalCards,
        },
        recentScans: formattedScans,
      },
    };
  }
}
