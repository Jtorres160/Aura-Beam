import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";
import { ScryfallService } from "../scryfall/scryfall.service";
import { YgoprodeckService } from "../ygoprodeck/ygoprodeck.service";

@Injectable()
export class CardsService {
  constructor(
    private prisma: PrismaService,
    private pokemonApi: PokemonTcgService,
    private scryfallApi: ScryfallService,
    private ygoprodeckApi: YgoprodeckService,
  ) {}

  async findAll(game?: string, q?: string) {
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

    const localCards = await this.prisma.card.findMany({
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
          this.pokemonApi.searchCards(q).then((results) => 
            results.map((apiCard: any) => this.pokemonApi.formatToInternalCard(apiCard))
          )
        );
      }
      
      if (!gameUpper || gameUpper === "MTG") {
        promises.push(
          this.scryfallApi.searchCards(q).then((results) => 
            results.map((apiCard: any) => this.scryfallApi.formatToInternalCard(apiCard))
          )
        );
      }
      
      if (!gameUpper || gameUpper === "YUGIOH") {
        promises.push(
          this.ygoprodeckApi.searchCards(q).then((results) => 
            results.map((apiCard: any) => this.ygoprodeckApi.formatToInternalCard(apiCard))
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
    
    return unique;
  }

  async findOne(id: string) {
    const card = await this.prisma.card.findUnique({
      where: { id },
      include: {
        prices: true,
        priceHistory: {
          take: 30,
          orderBy: { recordedAt: "desc" },
        },
      },
    });

    if (!card) {
      throw new NotFoundException(`Card with ID ${id} not found`);
    }

    return card;
  }

  async create(data: {
    externalId?: string;
    name: string;
    game: string;
    setName: string;
    setCode?: string;
    collectorNumber?: string;
    rarity?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    artist?: string;
    description?: string;
    types?: string; // Comma-separated for SQLite compatibility
    supertypes?: string;
    subtypes?: string;
    price?: {
      marketPrice?: number;
      lowPrice?: number;
      midPrice?: number;
      highPrice?: number;
      foilPrice?: number;
    };
  }) {
    const { price, ...cardData } = data;

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.create({
        data: {
          ...cardData,
          game: cardData.game.toUpperCase(),
        },
      });

      if (price) {
        await tx.cardPrice.create({
          data: {
            cardId: card.id,
            marketPrice: price.marketPrice,
            lowPrice: price.lowPrice,
            midPrice: price.midPrice,
            highPrice: price.highPrice,
            foilPrice: price.foilPrice,
          },
        });
      }

      return card;
    });
  }
}
