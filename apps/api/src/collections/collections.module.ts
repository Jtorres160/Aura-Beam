import { Module } from "@nestjs/common";
import { CollectionsService } from "./collections.service";
import { CollectionsController } from "./collections.controller";
import { PokemonTcgModule } from "../pokemon-tcg/pokemon-tcg.module";

@Module({
  imports: [PokemonTcgModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
})
export class CollectionsModule {}
