import { DashboardService } from "./dashboard.service";
export declare class DashboardController {
    private readonly dashboardService;
    constructor(dashboardService: DashboardService);
    getDashboardData(userId: string): Promise<{
        success: boolean;
        data: {
            stats: {
                collectionValue: number;
                cardsOwned: number;
            };
            recentScans: {
                id: string;
                name: string;
                set: string;
                game: string;
                price: number;
                confidence: string;
                createdAt: Date;
            }[];
        };
    }>;
}
