import { PrismaService } from "../prisma/prisma.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";
export declare class CollectionsService {
    private prisma;
    private pokemonApi;
    constructor(prisma: PrismaService, pokemonApi: PokemonTcgService);
    getUserCollection(userId: string): Promise<{
        success: boolean;
        data: {
            cards: ({
                card: {
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
                };
            } & {
                id: string;
                collectionId: string;
                cardId: string;
                quantity: number;
                condition: string | null;
                notes: string | null;
                addedAt: Date;
                updatedAt: Date;
            })[];
        } & {
            id: string;
            userId: string;
            name: string;
            createdAt: Date;
            updatedAt: Date;
        };
    }>;
    addCard(userId: string, cardId: string): Promise<{
        success: boolean;
        data: {
            id: string;
            collectionId: string;
            cardId: string;
            quantity: number;
            condition: string | null;
            notes: string | null;
            addedAt: Date;
            updatedAt: Date;
        };
        message: string;
    }>;
}
