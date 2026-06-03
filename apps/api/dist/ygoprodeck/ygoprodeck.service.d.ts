export declare class YgoprodeckService {
    private readonly logger;
    private readonly baseUrl;
    searchCards(query: string): Promise<any>;
    formatToInternalCard(externalCard: any): {
        externalId: any;
        name: any;
        game: string;
        setName: any;
        rarity: any;
        imageUrl: any;
        thumbnailUrl: any;
        price: {
            marketPrice: number;
        };
    };
}
