import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { DevicesService, EnrollDeviceInput } from "./devices.service.js";

@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(@Query("orgId") orgId: string) {
    return this.devices.listByOrg(orgId);
  }

  @Post()
  enroll(@Body() body: EnrollDeviceInput) {
    return this.devices.enroll(body);
  }

  @Patch(":id/heartbeat")
  heartbeat(@Param("id") id: string) {
    return this.devices.markSeen(id);
  }
}
