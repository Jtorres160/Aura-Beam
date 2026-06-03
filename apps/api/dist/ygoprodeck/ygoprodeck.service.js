"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var YgoprodeckService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.YgoprodeckService = void 0;
const common_1 = require("@nestjs/common");
let YgoprodeckService = YgoprodeckService_1 = class YgoprodeckService {
    constructor() {
        this.logger = new common_1.Logger(YgoprodeckService_1.name);
        this.baseUrl = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
    }
    async searchCards(query) {
        try {
            const response = await fetch(`${this.baseUrl}?fname=${encodeURIComponent(query)}`);
            if (!response.ok) {
                if (response.status === 400)
                    return [];
                throw new Error(`YGOPRODeck API Error: ${response.status}`);
            }
            const json = await response.json();
            return json.data || [];
        }
        catch (error) {
            this.logger.error(`Failed to fetch from YGOPRODeck API: ${error}`);
            return [];
        }
    }
    formatToInternalCard(externalCard) {
        const cardSet = externalCard.card_sets && externalCard.card_sets.length > 0 ? externalCard.card_sets[0] : null;
        const cardImage = externalCard.card_images && externalCard.card_images.length > 0 ? externalCard.card_images[0] : null;
        const cardPrice = externalCard.card_prices && externalCard.card_prices.length > 0 ? externalCard.card_prices[0] : null;
        return {
            externalId: externalCard.id.toString(),
            name: externalCard.name,
            game: "YUGIOH",
            setName: cardSet?.set_name || "Unknown Set",
            rarity: cardSet?.set_rarity || "Common",
            imageUrl: cardImage?.image_url || null,
            thumbnailUrl: cardImage?.image_url_small || null,
            price: {
                marketPrice: parseFloat(cardPrice?.tcgplayer_price || "0")
            }
        };
    }
};
exports.YgoprodeckService = YgoprodeckService;
exports.YgoprodeckService = YgoprodeckService = YgoprodeckService_1 = __decorate([
    (0, common_1.Injectable)()
], YgoprodeckService);
//# sourceMappingURL=ygoprodeck.service.js.map