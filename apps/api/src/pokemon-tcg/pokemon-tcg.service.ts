import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PokemonTcgService {
  private readonly logger = new Logger(PokemonTcgService.name);
  private readonly baseUrl = "https://api.pokemontcg.io/v2/cards";
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>("POKEMON_TCG_API_KEY") || "";
  }

  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["X-Api-Key"] = this.apiKey;
    }
    return headers;
  }

  async searchCards(query: string) {
    try {
      // Create a fuzzy search across name using the query
      // The Pokémon TCG API uses `name:*query*` for partial matches
      const searchQuery = `name:"*${encodeURIComponent(query)}*"`;
      const response = await fetch(`${this.baseUrl}?q=${searchQuery}&pageSize=50`, {
        headers: this.getHeaders(),
      });
      
      if (!response.ok) {
        throw new Error(`Pokemon TCG API Error: ${response.status}`);
      }

      const json = await response.json();
      return json.data || [];
    } catch (error) {
      this.logger.error(`Failed to fetch from Pokemon TCG API: ${error}`);
      return [];
    }
  }

  async getCardById(id: string) {
    try {
      const response = await fetch(`${this.baseUrl}/${id}`, {
        headers: this.getHeaders(),
      });
      if (!response.ok) return null;
      const json = await response.json();
      return json.data;
    } catch (error) {
      this.logger.error(`Failed to fetch card by ID ${id}: ${error}`);
      return null;
    }
  }

  // Format the external API response into our internal Card schema format
  formatToInternalCard(externalCard: any) {
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
}
