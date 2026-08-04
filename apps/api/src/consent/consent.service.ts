import { Injectable } from "@nestjs/common";
import { prisma, ConsentMethod } from "@aems/database";

export interface RecordConsentInput {
  orgId: string;
  userId: string;
  deviceId: string;
  policyVersion: string;
  method: ConsentMethod;
  ipAddress?: string;
}

/** Compliance-critical: every monitored device must have a matching consent record. */
@Injectable()
export class ConsentService {
  record(input: RecordConsentInput) {
    return prisma.consentRecord.create({ data: input });
  }

  listForUser(userId: string) {
    return prisma.consentRecord.findMany({ where: { userId }, orderBy: { consentedAt: "desc" } });
  }

  revoke(id: string) {
    return prisma.consentRecord.update({ where: { id }, data: { revokedAt: new Date() } });
  }
}
