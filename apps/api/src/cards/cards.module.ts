import { Module } from "@nestjs/common";
import { CardsService } from "./cards.service";
import { CardsController } from "./cards.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { PokemonTcgModule } from "../pokemon-tcg/pokemon-tcg.module";
import { ScryfallModule } from "../scryfall/scryfall.module";
import { YgoprodeckModule } from "../ygoprodeck/ygoprodeck.module";

@Module({
  imports: [PrismaModule, PokemonTcgModule, ScryfallModule, YgoprodeckModule],
  controllers: [CardsController],
  providers: [CardsService],
  exports: [CardsService],
})
export class CardsModule {}
