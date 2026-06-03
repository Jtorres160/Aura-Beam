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
var PokemonTcgService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PokemonTcgService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
let PokemonTcgService = PokemonTcgService_1 = class PokemonTcgService {
    constructor(configService) {
        this.configService = configService;
        this.logger = new common_1.Logger(PokemonTcgService_1.name);
        this.baseUrl = "https://api.pokemontcg.io/v2/cards";
        this.apiKey = this.configService.get("POKEMON_TCG_API_KEY") || "";
    }
    getHeaders() {
        const headers = {};
        if (this.apiKey) {
            headers["X-Api-Key"] = this.apiKey;
        }
        return headers;
    }
    async searchCards(query) {
        try {
            const searchQuery = `name:"*${encodeURIComponent(query)}*"`;
            const response = await fetch(`${this.baseUrl}?q=${searchQuery}&pageSize=50`, {
                headers: this.getHeaders(),
            });
            if (!response.ok) {
                throw new Error(`Pokemon TCG API Error: ${response.status}`);
            }
            const json = await response.json();
            return json.data || [];
        }
        catch (error) {
            this.logger.error(`Failed to fetch from Pokemon TCG API: ${error}`);
            return [];
        }
    }
    async getCardById(id) {
        try {
            const response = await fetch(`${this.baseUrl}/${id}`, {
                headers: this.getHeaders(),
            });
            if (!response.ok)
                return null;
            const json = await response.json();
            return json.data;
        }
        catch (error) {
            this.logger.error(`Failed to fetch card by ID ${id}: ${error}`);
            return null;
        }
    }
    formatToInternalCard(externalCard) {
        return {
            externalId: externalCard.id,
            name: externalCard.name,
            game: "POKEMON",
            setName: externalCard.set?.name || "Unknown Set",
            rarity: externalCard.rarity || "Common",
            imageUrl: externalCard.images?.large || externalCard.images?.small,
            thumbnailUrl: externalCard.images?.small,
            price: {
                marketPrice: externalCard.tcgplayer?.prices?.holofoil?.market ||
                    externalCard.tcgplayer?.prices?.normal?.market ||
                    externalCard.tcgplayer?.prices?.reverseHolofoil?.market || 0
            }
        };
    }
};
exports.PokemonTcgService = PokemonTcgService;
exports.PokemonTcgService = PokemonTcgService = PokemonTcgService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], PokemonTcgService);
//# sourceMappingURL=pokemon-tcg.service.js.map