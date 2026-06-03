import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class YgoprodeckService {
  private readonly logger = new Logger(YgoprodeckService.name);
  private readonly baseUrl = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

  async searchCards(query: string) {
    try {
      const response = await fetch(`${this.baseUrl}?fname=${encodeURIComponent(query)}`);
      
      if (!response.ok) {
        if (response.status === 400) return []; // YGOPRODeck returns 400 if no cards match
        throw new Error(`YGOPRODeck API Error: ${response.status}`);
      }

      const json = await response.json();
      return json.data || [];
    } catch (error) {
      this.logger.error(`Failed to fetch from YGOPRODeck API: ${error}`);
      return [];
    }
  }

  formatToInternalCard(externalCard: any) {
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
}
