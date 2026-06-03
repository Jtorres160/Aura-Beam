import { Module } from "@nestjs/common";
import { WatchlistService } from "./watchlist.service";
import { WatchlistController } from "./watchlist.controller";
import { PokemonTcgModule } from "../pokemon-tcg/pokemon-tcg.module";

@Module({
  imports: [PokemonTcgModule],
  controllers: [WatchlistController],
  providers: [WatchlistService],
})
export class WatchlistModule {}
