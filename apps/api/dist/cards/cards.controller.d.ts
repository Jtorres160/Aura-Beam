import { CardsService } from "./cards.service";
export declare class CardsController {
    private readonly cardsService;
    constructor(cardsService: CardsService);
    findAll(game?: string, q?: string): Promise<{
        success: boolean;
        data: any[];
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: {
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
        };
    }>;
}
