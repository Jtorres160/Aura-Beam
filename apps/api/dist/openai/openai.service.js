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
exports.OpenAIService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../prisma/prisma.service");
let OpenAIService = class OpenAIService {
    constructor(configService, prisma) {
        this.configService = configService;
        this.prisma = prisma;
        this.apiKey = this.configService.get("OPENAI_API_KEY") || "mock-openai-api-key";
        this.isMockMode = this.apiKey === "mock-openai-api-key" || !this.apiKey;
    }
    async identifyCardFromImage(base64Image) {
        if (this.isMockMode) {
            console.log("🤖 [Mock AI Mode]: Simulating GPT-4 Vision processing...");
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const allCards = await this.prisma.card.findMany({
                include: { prices: true },
            });
            if (allCards.length === 0) {
                throw new Error("No cards available in the database to mock.");
            }
            const randomIndex = Math.floor(Math.random() * allCards.length);
            const matchedCard = allCards[randomIndex];
            return {
                card: matchedCard,
                confidence: Number((85 + Math.random() * 14).toFixed(1)),
                ocrText: "Simulated OCR extraction text...",
                matchMethod: "mock",
            };
        }
        throw new Error("Real OpenAI integration is not fully implemented yet. Use mock keys.");
    }
};
exports.OpenAIService = OpenAIService;
exports.OpenAIService = OpenAIService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService])
], OpenAIService);
//# sourceMappingURL=openai.service.js.map