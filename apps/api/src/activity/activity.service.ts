import { Injectable } from "@nestjs/common";
import { prisma } from "@aems/database";

export interface StartWorkSessionInput {
  userId: string;
  deviceId: string;
}

export interface LogActivityEventInput {
  userId: string;
  deviceId: string;
  workSessionId?: string;
  appName: string;
  windowTitle?: string;
  url?: string;
  category?: string;
  startedAt: string;
  endedAt?: string;
}

export interface LogIdleEventInput {
  userId: string;
  deviceId: string;
  idleStartAt: string;
  idleEndAt?: string;
  durationSeconds?: number;
}

export interface LogScreenshotInput {
  userId: string;
  deviceId: string;
  workSessionId?: string;
  storageKey: string;
  thumbnailKey?: string;
  blurred?: boolean;
}

/**
 * Activity Engine: ingests work sessions, app-focus events, idle periods and
 * screenshot metadata from the desktop and Android agents, and serves the
 * merged per-user timeline consumed by the admin dashboard.
 */
@Injectable()
export class ActivityService {
  startWorkSession(input: StartWorkSessionInput) {
    return prisma.workSession.create({ data: input });
  }

  clockOut(sessionId: string) {
    return prisma.workSession.update({
      where: { id: sessionId },
      data: { clockOutAt: new Date() },
    });
  }

  logActivityEvent(input: LogActivityEventInput) {
    return prisma.activityEvent.create({
      data: {
        ...input,
        startedAt: new Date(input.startedAt),
        endedAt: input.endedAt ? new Date(input.endedAt) : undefined,
      },
    });
  }

  logIdleEvent(input: LogIdleEventInput) {
    return prisma.idleEvent.create({
      data: {
        ...input,
        idleStartAt: new Date(input.idleStartAt),
        idleEndAt: input.idleEndAt ? new Date(input.idleEndAt) : undefined,
      },
    });
  }

  logScreenshot(input: LogScreenshotInput) {
    return prisma.screenshot.create({ data: input });
  }

  /** Merged, time-ordered feed of a user's activity/idle/screenshot events for a window. */
  async getTimeline(userId: string, from: Date, to: Date) {
    const [activityEvents, idleEvents, screenshots] = await Promise.all([
      prisma.activityEvent.findMany({
        where: { userId, startedAt: { gte: from, lte: to } },
        orderBy: { startedAt: "asc" },
      }),
      prisma.idleEvent.findMany({
        where: { userId, idleStartAt: { gte: from, lte: to } },
        orderBy: { idleStartAt: "asc" },
      }),
      prisma.screenshot.findMany({
        where: { userId, capturedAt: { gte: from, lte: to } },
        orderBy: { capturedAt: "asc" },
      }),
    ]);

    return {
      activityEvents,
      idleEvents,
      screenshots,
    };
  }
}
