import { canViewProfile, visibleRoleFilter, type SessionProfile } from "@aems/auth";
import type { UserRole } from "@aems/types";
import type { FastifyInstance } from "fastify";

/**
 * Whether one person may read another's monitoring data, resolved against the
 * database rather than against the caller's role alone.
 *
 * Every route that takes a `profileId` used to decide this inline and identically:
 *
 * ```ts
 * if (profileId !== session.profileId && !canViewOthers(session.role)) return 403;
 * ```
 *
 * That predicate never reads the *target*, so every one of those routes handed a
 * manager the super admin's screenshots, timeline, websites, devices and location
 * history. Eight copies, one bug, and adding a ninth route reintroduced it silently
 * because the check looked complete on its own line.
 *
 * The lookup is the price of asking the right question: rank cannot be known from a
 * session. It is a single indexed read on the primary key, on routes that are about
 * to run heavier queries anyway.
 *
 * `app.supabase` is the **service-role** client and bypasses RLS, so on the API path
 * this is the boundary — not a hint that the database will re-check. The dashboard's
 * own direct Supabase reads are covered separately by the policies in
 * `…0020_manager_rank_visibility.sql`, which encode the same rule.
 */
export interface VisibilityDenial {
  statusCode: 403 | 404;
  error: string;
  message: string;
}

/**
 * The profile ids in this company that `session` may not see — normally the one or
 * two people who outrank the caller, and empty for a super admin.
 *
 * Aggregates (`/analytics/overview`) cannot use `visibleRoleFilter`: they count
 * `devices` and `work_sessions`, which carry `profile_id` and no role. Excluding a
 * short list of ids is cheaper than joining, and it inverts the right way — a new
 * role nobody remembered to classify is *hidden* from a manager rather than shown.
 *
 * Filtering these matters for consistency as much as privacy. A roster that stops at
 * employees beside a KPI that counted everyone reproduces exactly the defect the
 * `head: true` comment on that endpoint was written about: two numbers describing the
 * same set, disagreeing on one screen.
 */
export async function hiddenProfileIds(
  app: FastifyInstance,
  session: Pick<SessionProfile, "profileId" | "companyId" | "role">,
): Promise<string[]> {
  const roles = visibleRoleFilter(session.role);
  if (!roles) return [];

  const { data } = await app.supabase
    .from("profiles")
    .select("id, role")
    .eq("company_id", session.companyId)
    .not("role", "in", `(${roles.join(",")})`);

  return (data ?? []).map((row) => row.id).filter((id) => id !== session.profileId);
}

/**
 * Applies `hiddenProfileIds` to a query, or returns it untouched when there is
 * nothing to hide. Exists so a caller reads as one expression inside a `Promise.all`
 * instead of being hoisted into a `let` per query.
 */
export function excludeHidden<Q extends { not(column: string, op: "in", value: string): Q }>(
  query: Q,
  column: string,
  excluded: string | null,
): Q {
  return excluded ? query.not(column, "in", excluded) : query;
}

export async function profileVisibilityDenial(
  app: FastifyInstance,
  session: Pick<SessionProfile, "profileId" | "companyId" | "role">,
  profileId: string,
): Promise<VisibilityDenial | null> {
  if (profileId === session.profileId) return null;

  const { data } = await app.supabase
    .from("profiles")
    .select("id, role")
    .eq("id", profileId)
    .eq("company_id", session.companyId)
    .maybeSingle();

  // Absent means absent *from this company*, which a caller must not be able to tell
  // apart from "does not exist" — otherwise this route enumerates the other tenants.
  if (!data) {
    return { statusCode: 404, error: "not_found", message: "No such employee" };
  }

  if (!canViewProfile({ ...session, email: "" }, profileId, data.role as UserRole)) {
    // Deliberately the same wording a stranger's id produces. A manager who can tell
    // "forbidden" from "no such person" has been told the super admin's profile id is
    // real, which is the first half of an attack on it.
    return { statusCode: 404, error: "not_found", message: "No such employee" };
  }

  return null;
}
