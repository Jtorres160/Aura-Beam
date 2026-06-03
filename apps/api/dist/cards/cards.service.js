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
exports.CardsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const pokemon_tcg_service_1 = require("../pokemon-tcg/pokemon-tcg.service");
const scryfall_service_1 = require("../scryfall/scryfall.service");
const ygoprodeck_service_1 = require("../ygoprodeck/ygoprodeck.service");
let CardsService = class CardsService {
    constructor(prisma, pokemonApi, scryfallApi, ygoprodeckApi) {
        this.prisma = prisma;
        this.pokemonApi = pokemonApi;
        this.scryfallApi = scryfallApi;
        this.ygoprodeckApi = ygoprodeckApi;
    }
    async findAll(game, q) {
        const where = {};
        if (game) {
            where.game = game.toUpperCase();
        }
        if (q) {
            where.OR = [
                { name: { contains: q } },
                { setName: { contains: q } },
            ];
        }
        const localCards = await this.prisma.card.findMany({
            where,
            include: {
                prices: true,
            },
            orderBy: {
                name: "asc",
            },
            take: 20,
        });
        let liveCards = [];
        if (q) {
            const promises = [];
            const gameUpper = game?.toUpperCase();
            if (!gameUpper || gameUpper === "POKEMON") {
                promises.push(this.pokemonApi.searchCards(q).then((results) => results.map((apiCard) => this.pokemonApi.formatToInternalCard(apiCard))));
            }
            if (!gameUpper || gameUpper === "MTG") {
                promises.push(this.scryfallApi.searchCards(q).then((results) => results.map((apiCard) => this.scryfallApi.formatToInternalCard(apiCard))));
            }
            if (!gameUpper || gameUpper === "YUGIOH") {
                promises.push(this.ygoprodeckApi.searchCards(q).then((results) => results.map((apiCard) => this.ygoprodeckApi.formatToInternalCard(apiCard))));
            }
            const nestedResults = await Promise.all(promises);
            liveCards = nestedResults.flat().map((formatted) => ({
                id: formatted.externalId,
                ...formatted,
                prices: formatted.price,
            }));
        }
        const combined = [...localCards, ...liveCards];
        const unique = combined.filter((v, i, a) => a.findIndex(t => (t.id === v.id || t.externalId === v.externalId)) === i);
        return unique;
    }
    async findOne(id) {
        const card = await this.prisma.card.findUnique({
            where: { id },
            include: {
                prices: true,
                priceHistory: {
                    take: 30,
                    orderBy: { recordedAt: "desc" },
                },
            },
        });
        if (!card) {
            throw new common_1.NotFoundException(`Card with ID ${id} not found`);
        }
        return card;
    }
    async create(data) {
        const { price, ...cardData } = data;
        return this.prisma.$transaction(async (tx) => {
            const card = await tx.card.create({
                data: {
                    ...cardData,
                    game: cardData.game.toUpperCase(),
                },
            });
            if (price) {
                await tx.cardPrice.create({
                    data: {
                        cardId: card.id,
                        marketPrice: price.marketPrice,
                        lowPrice: price.lowPrice,
                        midPrice: price.midPrice,
                        highPrice: price.highPrice,
                        foilPrice: price.foilPrice,
                    },
                });
            }
            return card;
        });
    }
};
exports.CardsService = CardsService;
exports.CardsService = CardsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        pokemon_tcg_service_1.PokemonTcgService,
        scryfall_service_1.ScryfallService,
        ygoprodeck_service_1.YgoprodeckService])
], CardsService);
//# sourceMappingURL=cards.service.js.map