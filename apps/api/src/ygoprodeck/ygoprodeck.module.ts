import { Module } from "@nestjs/common";
import { YgoprodeckService } from "./ygoprodeck.service";

@Module({
  providers: [YgoprodeckService],
  exports: [YgoprodeckService],
})
export class YgoprodeckModule {}
