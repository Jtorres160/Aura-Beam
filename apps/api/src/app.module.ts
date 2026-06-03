import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { PrismaModule } from "./prisma/prisma.module";
import { CardsModule } from "./cards/cards.module";
import { ScannerModule } from "./scanner/scanner.module";
import { CollectionsModule } from "./collections/collections.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { PokemonTcgModule } from "./pokemon-tcg/pokemon-tcg.module";
import { WatchlistModule } from "./watchlist/watchlist.module";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: "../../.env", // point to root env
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000, // 1 minute
      limit: 100, // 100 requests per IP per minute
    }]),
    PrismaModule,
    AuthModule,
    CardsModule,
    ScannerModule,
    CollectionsModule,
    DashboardModule,
    PokemonTcgModule,
    WatchlistModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}


