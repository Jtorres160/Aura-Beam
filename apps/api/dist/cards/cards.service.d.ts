import { PrismaService } from "../prisma/prisma.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";
import { ScryfallService } from "../scryfall/scryfall.service";
import { YgoprodeckService } from "../ygoprodeck/ygoprodeck.service";
export declare class CardsService {
    private prisma;
    private pokemonApi;
    private scryfallApi;
    private ygoprodeckApi;
    constructor(prisma: PrismaService, pokemonApi: PokemonTcgService, scryfallApi: ScryfallService, ygoprodeckApi: YgoprodeckService);
    findAll(game?: string, q?: string): Promise<any[]>;
    findOne(id: string): Promise<{
        priceHistory: {
            id: string;
            cardId: string;
            marketPrice: number | null;
            lowPrice: number | null;
            midPrice: number | null;
            highPrice: number | null;
            recordedAt: Date;
        }[];
        prices: {
            id: string;
            cardId: string;
            marketPrice: number | null;
            lowPrice: number | null;
            midPrice: number | null;
            highPrice: number | null;
            foilPrice: number | null;
            currency: string;
            source: string;
            lastUpdated: Date;
            createdAt: Date;
            updatedAt: Date;
        };
    } & {
        id: string;
        externalId: string | null;
        name: string;
        game: string;
        setName: string;
        setCode: string | null;
        collectorNumber: string | null;
        rarity: string;
        imageUrl: string | null;
        thumbnailUrl: string | null;
        artist: string | null;
        description: string | null;
        types: string | null;
        supertypes: string | null;
        subtypes: string | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
    create(data: {
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
        types?: string;
        supertypes?: string;
        subtypes?: string;
        price?: {
            marketPrice?: number;
            lowPrice?: number;
            midPrice?: number;
            highPrice?: number;
            foilPrice?: number;
        };
    }): Promise<{
        id: string;
        externalId: string | null;
        name: string;
        game: string;
        setName: string;
        setCode: string | null;
        collectorNumber: string | null;
        rarity: string;
        imageUrl: string | null;
        thumbnailUrl: string | null;
        artist: string | null;
        description: string | null;
        types: string | null;
        supertypes: string | null;
        subtypes: string | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
}
