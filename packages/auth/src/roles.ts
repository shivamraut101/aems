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

/** Can this person see monitoring data belonging to someone else *at all*? */
export function canViewOthers(role: UserRole): boolean {
  return isManager(role);
}

/**
 * Can a `viewer` see the monitoring data of somebody holding `target`?
 *
 * `canViewOthers` answers "may this role see anyone but itself", which is the right
 * question for rendering a roster link and the wrong one for opening a profile: it
 * never looks at *whose* profile, so it granted a manager the super admin's
 * screenshots, timeline and location trail as readily as an employee's.
 *
 * The rule is rank-strict — a manager sees ranks **below** their own, so employees
 * and nobody else. Not a peer manager, not the owner. Two reasons it is drawn there
 * rather than at `manager_id`:
 *
 *  - **`manager_id` is null on most profiles today.** A rule that reads it would
 *    show a manager an empty roster on day one, which reads as a broken page rather
 *    than as an unset assignment. Rank needs no data anyone has to fill in first.
 *  - **Reporting lines are not a privilege boundary.** "Not my report" is an
 *    org-chart fact and changes when someone moves team; "outranks me" is the thing
 *    that must never invert. Narrowing further to a manager's own reports is a
 *    second, weaker filter that can be layered on this one — see `visibleRoleFilter`.
 *
 * Self is always visible: the rank comparison is strict, so without the first line a
 * manager could not open their own account page.
 */
export function canViewRole(viewer: UserRole, target: UserRole): boolean {
  if (isSuperAdmin(viewer)) return true;
  if (!canViewOthers(viewer)) return false;
  return ROLE_RANK[target] < ROLE_RANK[viewer];
}

/**
 * The roles a viewer may see in a list, or `null` for "no restriction".
 *
 * List endpoints cannot ask `canViewRole` per row without reading every row first,
 * so they push the same rule into the query instead. Returning `null` rather than
 * every role keeps the super admin's query free of a pointless `in (...)`.
 */
export function visibleRoleFilter(viewer: UserRole): UserRole[] | null {
  if (isSuperAdmin(viewer)) return null;
  return (Object.keys(ROLE_RANK) as UserRole[]).filter((role) => canViewRole(viewer, role));
}

/** Can this person change policies, enrol devices, or manage employees? */
export function canManageCompany(role: UserRole): boolean {
  return isSuperAdmin(role);
}

/** Only super admins read the audit trail. */
export function canViewAuditLog(role: UserRole): boolean {
  return isSuperAdmin(role);
}

export function canViewProfile(
  viewer: SessionProfile,
  targetProfileId: string,
  targetRole: UserRole,
): boolean {
  if (viewer.profileId === targetProfileId) return true;
  return canViewRole(viewer.role, targetRole);
}

/** The resolved identity behind a request. */
export interface SessionProfile {
  profileId: string;
  companyId: string;
  email: string;
  role: UserRole;
}
