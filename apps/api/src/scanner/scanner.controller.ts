import { Controller, Post, Body, UseGuards } from "@nestjs/common";
import { ScannerService } from "./scanner.service";
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { IsString, IsNotEmpty } from "class-validator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { GetUser } from "../auth/get-user.decorator";

class ScanCardDto {
  @IsString()
  @IsNotEmpty()
  image: string; // Base64 data URL

  @IsString()
  @IsNotEmpty()
  text: string;
}

@ApiTags("Scanner")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("scanner")
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  @Post("scan")
  @ApiOperation({ summary: "Scan a card image" })
  @ApiResponse({ status: 200, description: "Card successfully identified" })
  @ApiResponse({ status: 400, description: "Invalid image payload" })
  async scanCard(
    @GetUser("id") userId: string,
    @Body() payload: ScanCardDto,
  ) {
    return this.scannerService.processCardScan(payload.image, userId, payload.text);
  }
}

