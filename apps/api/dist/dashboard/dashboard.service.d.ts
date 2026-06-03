import { PrismaService } from "../prisma/prisma.service";
export declare class DashboardService {
    private prisma;
    constructor(prisma: PrismaService);
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
