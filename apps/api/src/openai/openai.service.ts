import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OpenAIService {
  private readonly apiKey: string;
  private readonly isMockMode: boolean;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiKey = this.configService.get<string>("OPENAI_API_KEY") || "mock-openai-api-key";
    this.isMockMode = this.apiKey === "mock-openai-api-key" || !this.apiKey;
  }

  async identifyCardFromImage(base64Image: string) {
    if (this.isMockMode) {
      console.log("🤖 [Mock AI Mode]: Simulating GPT-4 Vision processing...");
      // Simulate network latency & AI processing time
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Fetch all cards from DB
      const allCards = await this.prisma.card.findMany({
        include: { prices: true },
      });

      if (allCards.length === 0) {
        throw new Error("No cards available in the database to mock.");
      }

      // Pick a random card
      const randomIndex = Math.floor(Math.random() * allCards.length);
      const matchedCard = allCards[randomIndex];

      return {
        card: matchedCard,
        confidence: Number((85 + Math.random() * 14).toFixed(1)), // Random confidence between 85% and 99%
        ocrText: "Simulated OCR extraction text...",
        matchMethod: "mock",
      };
    }

    // --- Real OpenAI Integration goes here later ---
    // const response = await openai.chat.completions.create({ ... })
    throw new Error("Real OpenAI integration is not fully implemented yet. Use mock keys.");
  }
}
