"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ScryfallService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScryfallService = void 0;
const common_1 = require("@nestjs/common");
let ScryfallService = ScryfallService_1 = class ScryfallService {
    constructor() {
        this.logger = new common_1.Logger(ScryfallService_1.name);
        this.baseUrl = "https://api.scryfall.com/cards/search";
    }
    async searchCards(query) {
        try {
            const response = await fetch(`${this.baseUrl}?q=${encodeURIComponent(query)}`);
            if (!response.ok) {
                if (response.status === 404)
                    return [];
                throw new Error(`Scryfall API Error: ${response.status}`);
            }
            const json = await response.json();
            return json.data || [];
        }
        catch (error) {
            this.logger.error(`Failed to fetch from Scryfall API: ${error}`);
            return [];
        }
    }
    formatToInternalCard(externalCard) {
        return {
            externalId: externalCard.id,
            name: externalCard.name,
            game: "MTG",
            setName: externalCard.set_name || "Unknown Set",
            rarity: externalCard.rarity || "Common",
            imageUrl: externalCard.image_uris?.large || externalCard.image_uris?.normal || null,
            thumbnailUrl: externalCard.image_uris?.normal || externalCard.image_uris?.small || null,
            price: {
                marketPrice: parseFloat(externalCard.prices?.usd || "0")
            }
        };
    }
};
exports.ScryfallService = ScryfallService;
exports.ScryfallService = ScryfallService = ScryfallService_1 = __decorate([
    (0, common_1.Injectable)()
], ScryfallService);
//# sourceMappingURL=scryfall.service.js.map