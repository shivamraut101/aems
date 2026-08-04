import { Module } from "@nestjs/common";
import { ConsentController } from "./consent.controller.js";
import { ConsentService } from "./consent.service.js";

@Module({
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
