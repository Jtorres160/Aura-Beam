import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";

@Injectable()
export class WatchlistService {
  constructor(
    private prisma: PrismaService,
    private pokemonApi: PokemonTcgService,
  ) {}

  async getUserWatchlist(userId: string) {
    const watchlist = await this.prisma.watchlist.findMany({
      where: { userId },
      include: {
        card: {
          include: { prices: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return {
      success: true,
      data: watchlist,
    };
  }

  async addCard(userId: string, cardId: string) {
    // 1. Smart Upsert Card Logic
    let card = await this.prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      // It's a live API card, let's fetch it and insert it locally
      const externalCard = await this.pokemonApi.getCardById(cardId);
      if (!externalCard) {
        throw new NotFoundException("Card not found in local DB or external API");
      }

      const formatted = this.pokemonApi.formatToInternalCard(externalCard);
      card = await this.prisma.card.create({
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

      await this.prisma.cardPrice.create({
        data: {
          cardId: card.id,
          marketPrice: formatted.price.marketPrice,
        },
      });
    }

    const localCardId = card.id;

    // 2. Add to Watchlist
    const existingEntry = await this.prisma.watchlist.findUnique({
      where: {
        userId_cardId: {
          userId,
          cardId: localCardId,
        },
      },
    });

    if (existingEntry) {
      return { success: true, message: "Card is already on your watchlist" };
    }

    const added = await this.prisma.watchlist.create({
      data: {
        userId,
        cardId: localCardId,
      },
    });

    return { success: true, data: added, message: "Card added to watchlist" };
  }

  async removeCard(userId: string, cardId: string) {
    // cardId could be externalId, so resolve local ID first
    const card = await this.prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      throw new NotFoundException("Card not found");
    }

    await this.prisma.watchlist.delete({
      where: {
        userId_cardId: {
          userId,
          cardId: card.id,
        },
      },
    });

    return { success: true, message: "Card removed from watchlist" };
  }
}
