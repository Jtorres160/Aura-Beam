import { Injectable, BadRequestException } from "@nestjs/common";
import { OpenAIService } from "../openai/openai.service";
import { PokemonTcgService } from "../pokemon-tcg/pokemon-tcg.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ScannerService {
  constructor(
    private openaiService: OpenAIService,
    private pokemonApi: PokemonTcgService,
    private prisma: PrismaService,
  ) {}

  async processCardScan(imageBase64: string, userId: string, ocrText?: string) {
    if (!ocrText) {
      throw new BadRequestException("No OCR text provided from scanner");
    }

    try {
      // 1. Clean up OCR text (take first few words to avoid massive queries)
      const cleanText = ocrText.replace(/[^a-zA-Z0-9 ]/g, "").trim().split(" ").slice(0, 3).join(" ");
      
      // 2. Search Pokemon TCG API
      const apiResults = await this.pokemonApi.searchCards(cleanText);
      
      let matchedCard;
      if (apiResults && apiResults.length > 0) {
        // Take the first match
        matchedCard = this.pokemonApi.formatToInternalCard(apiResults[0]);
      } else {
        // Fallback if nothing found
        throw new BadRequestException("Could not identify any cards from the text: " + cleanText);
      }

      // 3. Upsert the card into our local DB so it can be referenced in history
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
        // Insert prices too
        await this.prisma.cardPrice.create({
          data: {
            cardId: localCard.id,
            marketPrice: matchedCard.price.marketPrice,
          },
        });
      }

      // 4. Save to ScanHistory
      const history = await this.prisma.scanHistory.create({
        data: {
          userId,
          cardId: localCard.id,
          confidence: 95, // Hardcoded confidence for now since we aren't using OpenAI
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
    } catch (error) {
      console.error("Scanner Pipeline Error:", error);
      throw new BadRequestException("Failed to process card image.");
    }
  }
}
