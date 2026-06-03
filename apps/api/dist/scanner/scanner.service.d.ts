import { OpenAIService } from "../openai/openai.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";
import { PrismaService } from "../prisma/prisma.service";
export declare class ScannerService {
    private openaiService;
    private pokemonApi;
    private prisma;
    constructor(openaiService: OpenAIService, pokemonApi: PokemonTcgService, prisma: PrismaService);
    processCardScan(imageBase64: string, userId: string, ocrText?: string): Promise<{
        success: boolean;
        data: {
            id: string;
            name: string;
            set: string;
            game: string;
            price: any;
            rarity: string;
            confidence: number;
            imageUrl: string;
            historyId: string;
        };
    }>;
}
