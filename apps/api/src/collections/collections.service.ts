import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";

@Injectable()
export class CollectionsService {
  constructor(
    private prisma: PrismaService,
    private pokemonApi: PokemonTcgService,
  ) {}

  async getUserCollection(userId: string) {
    let collection = await this.prisma.collection.findFirst({
      where: { userId },
      include: {
        cards: {
          include: {
            card: {
              include: {
                prices: true,
              },
            },
          },
          orderBy: {
            addedAt: 'desc',
          },
        },
      },
    });

    // If user has no collection, create a default one
    if (!collection) {
      collection = await this.prisma.collection.create({
        data: {
          userId,
          name: "My Core Collection",
        },
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
    }

    return {
      success: true,
      data: collection,
    };
  }

  async addCard(userId: string, cardId: string) {
    // 1. Get or create primary collection
    let collection = await this.prisma.collection.findFirst({
      where: { userId },
    });

    if (!collection) {
      collection = await this.prisma.collection.create({
        data: {
          userId,
          name: "My Core Collection",
        },
      });
    }

    // 2. Verify card exists locally OR fetch and insert from API
    let card = await this.prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      // It's a live API card, let's fetch it and insert it locally!
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

      // Insert prices too
      await this.prisma.cardPrice.create({
        data: {
          cardId: card.id,
          marketPrice: formatted.price.marketPrice,
        },
      });
    }

    // Ensure we use the local DB ID for the collection entry, not the external one
    const localCardId = card.id;

    // 3. Upsert CollectionCard
    const existingEntry = await this.prisma.collectionCard.findUnique({
      where: {
        collectionId_cardId: {
          collectionId: collection.id,
          cardId: localCardId,
        },
      },
    });

    if (existingEntry) {
      const updated = await this.prisma.collectionCard.update({
        where: { id: existingEntry.id },
        data: { quantity: existingEntry.quantity + 1 },
      });
      return { success: true, data: updated, message: "Card quantity updated" };
    } else {
      const added = await this.prisma.collectionCard.create({
        data: {
          collectionId: collection.id,
          cardId: localCardId,
          quantity: 1,
        },
      });
      return { success: true, data: added, message: "Card added to collection" };
    }
  }
}
