import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ConsentService, RecordConsentInput } from "./consent.service.js";

@Controller("consent")
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get()
  list(@Query("userId") userId: string) {
    return this.consent.listForUser(userId);
  }

  @Post()
  record(@Body() body: RecordConsentInput) {
    return this.consent.record(body);
  }

  @Patch(":id/revoke")
  revoke(@Param("id") id: string) {
    return this.consent.revoke(id);
  }
}
