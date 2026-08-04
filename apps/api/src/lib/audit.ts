import type { AemsSupabaseClient } from "@aems/supabase";
import type { Json } from "@aems/types";

/**
 * Appends to the audit trail.
 *
 * Deliberately swallows its own failures: an audit write must never be the reason a
 * legitimate request 500s. Failures are logged so they surface in monitoring rather
 * than vanishing.
 */
export async function recordAudit(
  supabase: AemsSupabaseClient,
  entry: {
    companyId: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Json;
  },
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  const { error } = await supabase.from("audit_log_entries").insert({
    company_id: entry.companyId,
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId,
    metadata: entry.metadata ?? null,
  });

  if (error) {
    log?.error({ err: error, action: entry.action }, "failed to write audit log entry");
  }
}
