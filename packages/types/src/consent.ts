export type ConsentMethod = "in_app_dialog" | "onboarding_portal" | "signed_document";

/** Recorded proof that a device's user was notified of and agreed to monitoring. */
export interface ConsentRecord {
  id: string;
  orgId: string;
  userId: string;
  deviceId: string;
  policyVersion: string;
  consentedAt: string;
  method: ConsentMethod;
  ipAddress: string | null;
  revokedAt: string | null;
}
