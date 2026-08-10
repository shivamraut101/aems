import { canViewAuditLog } from "@aems/auth";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { validationFailure } from "../lib/validation.js";

/**
 * Reading the audit trail.
 *
 * `recordAudit` has been writing since the first migration — 17 action types, every
 * consent grant, device revocation, employee off-boarding and collection change, each
 * with the actor and a before/after. Nothing could read any of it. `canViewAuditLog`
 * was defined in `packages/auth` and called from nowhere, and there was no route.
 *
 * A trail nobody can read is not an audit trail; it is a table that grows. This is the
 * half that makes non-negotiable #5 — the log is append-only — mean something, because
 * "append-only" is a promise about a record somebody eventually reads.
 *
 * Super admin only, via `canViewAuditLog`. Managers change what devices collect and
 * who reports to whom; a manager who could also read the log could check whether their
 * own change had been noticed. The one reader who should see everything is the one who
 * cannot quietly be the subject of it.
 */

const querySchema = z.object({
  /** Narrow to one kind of event — "collection.changed", "consent.revoked". */
  action: z.string().min(1).max(60).optional(),
  /** Narrow to one device, employee or policy, by the id the entry targets. */
  targetId: z.string().min(1).max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /**
   * Paged rather than unbounded. A year of a busy company is tens of thousands of
   * rows, and the honest failure of an audit screen is one that will not open.
   */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const session = request.session!;

    // requireSuperAdmin already covers this. Asked again through the shared predicate
    // so that if the roles ever change, the guard and the policy change together
    // rather than one of them being found later.
    if (!canViewAuditLog(session.role)) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Not your audit log", statusCode: 403 });
    }

    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_query"));
    }

    const { action, targetId, from, to, limit, before } = parsed.data;

    let query = app.supabase
      .from("audit_log_entries")
      .select("id, action, target_type, target_id, metadata, created_at, profiles(full_name, email)")
      // The tenant boundary. This route runs on the service-role key, so the filter
      // is the only thing between one company's admin and another's history.
      .eq("company_id", session.companyId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (action) query = query.eq("action", action);
    if (targetId) query = query.eq("target_id", targetId);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    // Keyset paging on the identity column rather than an offset: entries are only
    // ever appended, so an offset would shift under the reader as new ones land and
    // silently skip the row that moved across the page boundary.
    if (before) query = query.lt("id", before);

    const { data, error } = await query;

    if (error) {
      return reply
        .code(500)
        .send({ error: "audit_unavailable", message: error.message, statusCode: 500 });
    }

    const entries = (data ?? []).map((row) => {
      const actor = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return {
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata: row.metadata,
        createdAt: row.created_at,
        // Null once the actor has left. The entry outlives them, which is the point of
        // `on delete set null` on that column rather than a cascade.
        actorName: actor?.full_name ?? actor?.email ?? null,
      };
    });

    return {
      entries,
      // The cursor for the next page, or null at the end. Returned rather than left to
      // the caller to derive, so paging cannot disagree with the ordering above.
      nextBefore: entries.length === limit ? (entries[entries.length - 1]?.id ?? null) : null,
    };
  });
};
