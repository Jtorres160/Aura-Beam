import { WatchlistService } from "./watchlist.service";
export declare class WatchlistController {
    private readonly watchlistService;
    constructor(watchlistService: WatchlistService);
    getWatchlist(userId: string): Promise<{
        success: boolean;
        data: ({
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
            userId: string;
            cardId: string;
            alertAbove: number | null;
            alertBelow: number | null;
            alertEnabled: boolean;
            createdAt: Date;
            updatedAt: Date;
        })[];
    }>;
    addCard(userId: string, cardId: string): Promise<{
        success: boolean;
        message: string;
        data?: undefined;
    } | {
        success: boolean;
        data: {
            id: string;
            userId: string;
            cardId: string;
            alertAbove: number | null;
            alertBelow: number | null;
            alertEnabled: boolean;
            createdAt: Date;
            updatedAt: Date;
        };
        message: string;
    }>;
    removeCard(userId: string, cardId: string): Promise<{
        success: boolean;
        message: string;
    }>;
}
