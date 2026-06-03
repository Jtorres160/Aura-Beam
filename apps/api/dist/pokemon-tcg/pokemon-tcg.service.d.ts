import { ConfigService } from "@nestjs/config";
export declare class PokemonTcgService {
    private readonly configService;
    private readonly logger;
    private readonly baseUrl;
    private readonly apiKey;
    constructor(configService: ConfigService);
    private getHeaders;
    searchCards(query: string): Promise<any>;
    getCardById(id: string): Promise<any>;
    formatToInternalCard(externalCard: any): {
        externalId: any;
        name: any;
        game: string;
        setName: any;
        rarity: any;
        imageUrl: any;
        thumbnailUrl: any;
        price: {
            marketPrice: any;
        };
    };
}
