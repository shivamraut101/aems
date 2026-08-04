import { Injectable } from "@nestjs/common";
import { prisma, Prisma } from "@aems/database";

export interface RecordAuditEntryInput {
  orgId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/** Append-only trail of admin actions (policy changes, consent revocations, exports, etc). */
@Injectable()
export class AuditLogService {
  record(input: RecordAuditEntryInput) {
    return prisma.auditLogEntry.create({
      data: { ...input, metadata: input.metadata as Prisma.InputJsonValue | undefined },
    });
  }

  listByOrg(orgId: string) {
    return prisma.auditLogEntry.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
  }
}
