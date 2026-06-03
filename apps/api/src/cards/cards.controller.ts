import { Controller, Get, Param, Query } from "@nestjs/common";
import { CardsService } from "./cards.service";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";

@ApiTags("Cards")
@Controller("cards")
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  @ApiOperation({ summary: "Get all cards, optionally filtered by game or search query" })
  @ApiQuery({ name: "game", required: false, enum: ["POKEMON", "MTG", "YUGIOH"], description: "Game type filter" })
  @ApiQuery({ name: "q", required: false, description: "Search query for card name or set" })
  @ApiResponse({ status: 200, description: "Successfully fetched cards" })
  async findAll(
    @Query("game") game?: string,
    @Query("q") q?: string,
  ) {
    const cards = await this.cardsService.findAll(game, q);
    return {
      success: true,
      data: cards,
    };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get card details by ID" })
  @ApiResponse({ status: 200, description: "Card details successfully fetched" })
  @ApiResponse({ status: 404, description: "Card not found" })
  async findOne(@Param("id") id: string) {
    const card = await this.cardsService.findOne(id);
    return {
      success: true,
      data: card,
    };
  }
}
