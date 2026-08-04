import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  ActivityService,
  StartWorkSessionInput,
  LogActivityEventInput,
  LogIdleEventInput,
  LogScreenshotInput,
} from "./activity.service.js";

@Controller("activity")
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Post("sessions")
  startSession(@Body() body: StartWorkSessionInput) {
    return this.activity.startWorkSession(body);
  }

  @Patch("sessions/:id/clock-out")
  clockOut(@Param("id") id: string) {
    return this.activity.clockOut(id);
  }

  @Post("events")
  logEvent(@Body() body: LogActivityEventInput) {
    return this.activity.logActivityEvent(body);
  }

  @Post("idle")
  logIdle(@Body() body: LogIdleEventInput) {
    return this.activity.logIdleEvent(body);
  }

  @Post("screenshots")
  logScreenshot(@Body() body: LogScreenshotInput) {
    return this.activity.logScreenshot(body);
  }

  @Get("timeline")
  timeline(@Query("userId") userId: string, @Query("from") from: string, @Query("to") to: string) {
    return this.activity.getTimeline(userId, new Date(from), new Date(to));
  }
}
