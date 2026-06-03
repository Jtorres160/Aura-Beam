import { Module } from "@nestjs/common";
import { PokemonTcgService } from "./pokemon-tcg.service";

@Module({
  providers: [PokemonTcgService],
  exports: [PokemonTcgService],
})
export class PokemonTcgModule {}
