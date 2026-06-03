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
exports.CollectionsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const pokemon_tcg_service_1 = require("../pokemon-tcg/pokemon-tcg.service");
let CollectionsService = class CollectionsService {
    constructor(prisma, pokemonApi) {
        this.prisma = prisma;
        this.pokemonApi = pokemonApi;
    }
    async getUserCollection(userId) {
        let collection = await this.prisma.collection.findFirst({
            where: { userId },
            include: {
                cards: {
                    include: {
                        card: {
                            include: {
                                prices: true,
                            },
                        },
                    },
                    orderBy: {
                        addedAt: 'desc',
                    },
                },
            },
        });
        if (!collection) {
            collection = await this.prisma.collection.create({
                data: {
                    userId,
                    name: "My Core Collection",
                },
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
        }
        return {
            success: true,
            data: collection,
        };
    }
    async addCard(userId, cardId) {
        let collection = await this.prisma.collection.findFirst({
            where: { userId },
        });
        if (!collection) {
            collection = await this.prisma.collection.create({
                data: {
                    userId,
                    name: "My Core Collection",
                },
            });
        }
        let card = await this.prisma.card.findFirst({
            where: {
                OR: [{ id: cardId }, { externalId: cardId }],
            },
        });
        if (!card) {
            const externalCard = await this.pokemonApi.getCardById(cardId);
            if (!externalCard) {
                throw new common_1.NotFoundException("Card not found in local DB or external API");
            }
            const formatted = this.pokemonApi.formatToInternalCard(externalCard);
            card = await this.prisma.card.create({
                data: {
                    externalId: formatted.externalId,
                    name: formatted.name,
                    game: formatted.game,
                    setName: formatted.setName,
                    rarity: formatted.rarity,
                    imageUrl: formatted.imageUrl,
                    thumbnailUrl: formatted.thumbnailUrl,
                },
            });
            await this.prisma.cardPrice.create({
                data: {
                    cardId: card.id,
                    marketPrice: formatted.price.marketPrice,
                },
            });
        }
        const localCardId = card.id;
        const existingEntry = await this.prisma.collectionCard.findUnique({
            where: {
                collectionId_cardId: {
                    collectionId: collection.id,
                    cardId: localCardId,
                },
            },
        });
        if (existingEntry) {
            const updated = await this.prisma.collectionCard.update({
                where: { id: existingEntry.id },
                data: { quantity: existingEntry.quantity + 1 },
            });
            return { success: true, data: updated, message: "Card quantity updated" };
        }
        else {
            const added = await this.prisma.collectionCard.create({
                data: {
                    collectionId: collection.id,
                    cardId: localCardId,
                    quantity: 1,
                },
            });
            return { success: true, data: added, message: "Card added to collection" };
        }
    }
};
exports.CollectionsService = CollectionsService;
exports.CollectionsService = CollectionsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        pokemon_tcg_service_1.PokemonTcgService])
], CollectionsService);
//# sourceMappingURL=collections.service.js.map