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
exports.ScannerService = void 0;
const common_1 = require("@nestjs/common");
const openai_service_1 = require("../openai/openai.service");
const pokemon_tcg_service_1 = require("../pokemon-tcg/pokemon-tcg.service");
const prisma_service_1 = require("../prisma/prisma.service");
let ScannerService = class ScannerService {
    constructor(openaiService, pokemonApi, prisma) {
        this.openaiService = openaiService;
        this.pokemonApi = pokemonApi;
        this.prisma = prisma;
    }
    async processCardScan(imageBase64, userId, ocrText) {
        if (!ocrText) {
            throw new common_1.BadRequestException("No OCR text provided from scanner");
        }
        try {
            const cleanText = ocrText.replace(/[^a-zA-Z0-9 ]/g, "").trim().split(" ").slice(0, 3).join(" ");
            const apiResults = await this.pokemonApi.searchCards(cleanText);
            let matchedCard;
            if (apiResults && apiResults.length > 0) {
                matchedCard = this.pokemonApi.formatToInternalCard(apiResults[0]);
            }
            else {
                throw new common_1.BadRequestException("Could not identify any cards from the text: " + cleanText);
            }
            let localCard = await this.prisma.card.findFirst({
                where: { externalId: matchedCard.externalId }
            });
            if (!localCard) {
                localCard = await this.prisma.card.create({
                    data: {
                        externalId: matchedCard.externalId,
                        name: matchedCard.name,
                        game: matchedCard.game,
                        setName: matchedCard.setName,
                        rarity: matchedCard.rarity,
                        imageUrl: matchedCard.imageUrl,
                        thumbnailUrl: matchedCard.thumbnailUrl,
                    }
                });
                await this.prisma.cardPrice.create({
                    data: {
                        cardId: localCard.id,
                        marketPrice: matchedCard.price.marketPrice,
                    },
                });
            }
            const history = await this.prisma.scanHistory.create({
                data: {
                    userId,
                    cardId: localCard.id,
                    confidence: 95,
                    imageUrl: localCard.imageUrl,
                },
            });
            return {
                success: true,
                data: {
                    id: localCard.id,
                    name: localCard.name,
                    set: localCard.setName,
                    game: localCard.game,
                    price: matchedCard.price.marketPrice,
                    rarity: localCard.rarity,
                    confidence: 95,
                    imageUrl: localCard.imageUrl,
                    historyId: history.id,
                },
            };
        }
        catch (error) {
            console.error("Scanner Pipeline Error:", error);
            throw new common_1.BadRequestException("Failed to process card image.");
        }
    }
};
exports.ScannerService = ScannerService;
exports.ScannerService = ScannerService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [openai_service_1.OpenAIService,
        pokemon_tcg_service_1.PokemonTcgService,
        prisma_service_1.PrismaService])
], ScannerService);
//# sourceMappingURL=scanner.service.js.map