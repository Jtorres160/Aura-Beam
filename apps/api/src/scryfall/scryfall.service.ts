import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class ScryfallService {
  private readonly logger = new Logger(ScryfallService.name);
  private readonly baseUrl = "https://api.scryfall.com/cards/search";

  async searchCards(query: string) {
    try {
      const response = await fetch(`${this.baseUrl}?q=${encodeURIComponent(query)}`);
      
      if (!response.ok) {
        if (response.status === 404) return []; // Scryfall returns 404 if no cards match
        throw new Error(`Scryfall API Error: ${response.status}`);
      }

      const json = await response.json();
      return json.data || [];
    } catch (error) {
      this.logger.error(`Failed to fetch from Scryfall API: ${error}`);
      return [];
    }
  }

  formatToInternalCard(externalCard: any) {
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
}
