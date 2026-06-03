import { Controller, Get, Post, Body, UseGuards } from "@nestjs/common";
import { CollectionsService } from "./collections.service";
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { IsString, IsNotEmpty } from "class-validator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { GetUser } from "../auth/get-user.decorator";

class AddCardDto {
  @IsString()
  @IsNotEmpty()
  cardId: string;
}

@ApiTags("Collections")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("collections")
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated user's primary collection" })
  @ApiResponse({ status: 200, description: "Returns the collection with its nested cards and prices" })
  async getUserCollection(@GetUser("id") userId: string) {
    return this.collectionsService.getUserCollection(userId);
  }

  @Post("add")
  @ApiOperation({ summary: "Add a card to the authenticated user's collection" })
  @ApiResponse({ status: 201, description: "Successfully added card or incremented quantity" })
  async addCard(
    @GetUser("id") userId: string,
    @Body() payload: AddCardDto,
  ) {
    return this.collectionsService.addCard(userId, payload.cardId);
  }
}

