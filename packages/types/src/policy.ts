/** Org-level configuration for how monitoring behaves, versioned for consent tracking. */
export interface Policy {
  id: string;
  orgId: string;
  version: string;
  name: string;
  screenshotIntervalSeconds: number;
  idleThresholdSeconds: number;
  trackedCategories: string[];
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  orgId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
