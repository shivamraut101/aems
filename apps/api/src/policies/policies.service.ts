import { Injectable } from "@nestjs/common";
import { prisma } from "@aems/database";

export interface CreatePolicyInput {
  orgId: string;
  version: string;
  name: string;
  screenshotIntervalSeconds?: number;
  idleThresholdSeconds?: number;
  trackedCategories?: string[];
}

/** Org-level monitoring configuration; new versions require re-consent from users. */
@Injectable()
export class PoliciesService {
  listByOrg(orgId: string) {
    return prisma.policy.findMany({ where: { orgId }, orderBy: { updatedAt: "desc" } });
  }

  create(input: CreatePolicyInput) {
    return prisma.policy.create({ data: input });
  }
}
