import { ScannerService } from "./scanner.service";
declare class ScanCardDto {
    image: string;
    text: string;
}
export declare class ScannerController {
    private readonly scannerService;
    constructor(scannerService: ScannerService);
    scanCard(userId: string, payload: ScanCardDto): Promise<{
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
export {};
