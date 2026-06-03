import { Controller, Get, Post, Delete, Param, Body, UseGuards } from "@nestjs/common";
import { WatchlistService } from "./watchlist.service";
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { GetUser } from "../auth/get-user.decorator";

@ApiTags("Watchlist")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("watchlist")
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated user's watchlist" })
  @ApiResponse({ status: 200, description: "Successfully fetched watchlist" })
  async getWatchlist(@GetUser("id") userId: string) {
    return this.watchlistService.getUserWatchlist(userId);
  }

  @Post("add")
  @ApiOperation({ summary: "Add card to the authenticated user's watchlist" })
  @ApiResponse({ status: 201, description: "Card successfully added" })
  async addCard(
    @GetUser("id") userId: string,
    @Body("cardId") cardId: string,
  ) {
    return this.watchlistService.addCard(userId, cardId);
  }

  @Delete("remove/:cardId")
  @ApiOperation({ summary: "Remove card from the authenticated user's watchlist" })
  @ApiResponse({ status: 200, description: "Card successfully removed" })
  async removeCard(
    @GetUser("id") userId: string,
    @Param("cardId") cardId: string,
  ) {
    return this.watchlistService.removeCard(userId, cardId);
  }
}

