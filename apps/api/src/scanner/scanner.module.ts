import { Module } from "@nestjs/common";
import { ScannerService } from "./scanner.service";
import { ScannerController } from "./scanner.controller";
import { OpenAIModule } from "../openai/openai.module";
import { PokemonTcgModule } from "../pokemon-tcg/pokemon-tcg.module";

@Module({
  imports: [OpenAIModule, PokemonTcgModule],
  controllers: [ScannerController],
  providers: [ScannerService],
})
export class ScannerModule {}
