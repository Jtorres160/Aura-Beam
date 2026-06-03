"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
let DashboardService = class DashboardService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getDashboardData(userId) {
        const collection = await this.prisma.collection.findFirst({
            where: { userId },
            include: {
                cards: {
                    include: {
                        card: {
                            include: { prices: true },
                        },
                    },
                },
            },
        });
        let totalValue = 0;
        let totalCards = 0;
        if (collection && collection.cards) {
            for (const cCard of collection.cards) {
                totalCards += cCard.quantity;
                const marketPrice = cCard.card.prices?.marketPrice || 0;
                totalValue += marketPrice * cCard.quantity;
            }
        }
        const recentScans = await this.prisma.scanHistory.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 5,
            include: {
                card: {
                    include: { prices: true },
                },
            },
        });
        const formattedScans = recentScans.map((scan) => ({
            id: scan.id,
            name: scan.card?.name || "Unknown Card",
            set: scan.card?.setName || "Unknown Set",
            game: scan.card?.game || "Unknown",
            price: scan.card?.prices?.marketPrice || 0,
            confidence: scan.confidence ? `${scan.confidence}%` : "100%",
            createdAt: scan.createdAt,
        }));
        return {
            success: true,
            data: {
                stats: {
                    collectionValue: totalValue,
                    cardsOwned: totalCards,
                },
                recentScans: formattedScans,
            },
        };
    }
};
exports.DashboardService = DashboardService;
exports.DashboardService = DashboardService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], DashboardService);
//# sourceMappingURL=dashboard.service.js.map