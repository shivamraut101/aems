import { Injectable } from "@nestjs/common";
import { prisma, DevicePlatform } from "@aems/database";

export interface EnrollDeviceInput {
  orgId: string;
  userId: string;
  platform: DevicePlatform;
  label: string;
  osVersion: string;
  agentVersion: string;
}

/** Device inventory: enrollment, lookup, and last-seen tracking for desktop + Android agents. */
@Injectable()
export class DevicesService {
  listByOrg(orgId: string) {
    return prisma.device.findMany({ where: { orgId }, orderBy: { enrolledAt: "desc" } });
  }

  enroll(input: EnrollDeviceInput) {
    return prisma.device.create({ data: input });
  }

  markSeen(deviceId: string) {
    return prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
  }
}
