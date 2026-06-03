import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
export declare class OpenAIService {
    private configService;
    private prisma;
    private readonly apiKey;
    private readonly isMockMode;
    constructor(configService: ConfigService, prisma: PrismaService);
    identifyCardFromImage(base64Image: string): Promise<{
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
        confidence: number;
        ocrText: string;
        matchMethod: string;
    }>;
}
