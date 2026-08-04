import type { UserRole } from "@aems/types";

/**
 * Role logic, mirrored from the RLS policies in
 * supabase/migrations/20260805000002_rls_policies.sql.
 *
 * This is a UX layer — it decides what to render and which requests to skip. It is
 * NOT the security boundary. The database is. If you change a rule here, change the
 * matching policy too, or the UI will offer actions the database then refuses.
 */

export const ROLE_RANK: Record<UserRole, number> = {
  employee: 0,
  manager: 1,
  super_admin: 2,
};

export function isManager(role: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.manager;
}

export function isSuperAdmin(role: UserRole): boolean {
  return role === "super_admin";
}

/** Can this person see monitoring data belonging to someone else? */
export function canViewOthers(role: UserRole): boolean {
  return isManager(role);
}

/** Can this person change policies, enrol devices, or manage employees? */
export function canManageCompany(role: UserRole): boolean {
  return isSuperAdmin(role);
}

/** Only super admins read the audit trail. */
export function canViewAuditLog(role: UserRole): boolean {
  return isSuperAdmin(role);
}

export function canViewProfile(viewer: SessionProfile, targetProfileId: string): boolean {
  if (viewer.profileId === targetProfileId) return true;
  return canViewOthers(viewer.role);
}

/** The resolved identity behind a request. */
export interface SessionProfile {
  profileId: string;
  companyId: string;
  email: string;
  role: UserRole;
}
