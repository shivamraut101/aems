import { adminClient, authorize, json } from "../_shared/client.ts";

/** A device silent for longer than this is treated as offline. */
const OFFLINE_AFTER_MS = 10 * 60 * 1000;

/** An idle stretch longer than this raises an alert. */
const IDLE_ALERT_SECONDS = 30 * 60;

interface Alert {
  companyId: string;
  kind: "device_offline" | "prolonged_idle" | "report_ready";
  targetType: string;
  targetId: string;
  detail: string;
}

/**
 * Notification worker — idle alerts, offline alerts, report notifications.
 *
 * Alerts are written to the audit log rather than pushed anywhere. Delivery
 * (email, Slack, in-app) is deliberately not wired up: sending a manager an
 * automated "your employee has been idle" message is a policy decision the client
 * has not made yet, and the wrong default here is worse than no default.
 */
Deno.serve(async (request: Request) => {
  const denied = authorize(request);
  if (denied) return denied;

  const supabase = adminClient();
  const now = Date.now();
  const alerts: Alert[] = [];

  // -- devices that stopped reporting ---------------------------------------
  const { data: devices, error: deviceError } = await supabase
    .from("devices")
    .select("id, company_id, label, last_seen_at, status")
    .eq("status", "active");

  if (deviceError) return json({ error: deviceError.message }, 500);

  for (const device of devices ?? []) {
    if (!device.last_seen_at) continue;
    if (now - Date.parse(device.last_seen_at) <= OFFLINE_AFTER_MS) continue;

    alerts.push({
      companyId: device.company_id,
      kind: "device_offline",
      targetType: "device",
      targetId: device.id,
      detail: `${device.label} has not reported since ${device.last_seen_at}`,
    });

    // Reflect the state so the dashboard agrees with the alert.
    await supabase.from("devices").update({ status: "offline" }).eq("id", device.id);
  }

  // -- unusually long idle stretches ----------------------------------------
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const { data: idleEvents } = await supabase
    .from("idle_events")
    .select("id, company_id, profile_id, duration_seconds")
    .gte("idle_start_at", since)
    .gte("duration_seconds", IDLE_ALERT_SECONDS);

  for (const event of idleEvents ?? []) {
    alerts.push({
      companyId: event.company_id,
      kind: "prolonged_idle",
      targetType: "profile",
      targetId: event.profile_id,
      detail: `Idle for ${Math.round((event.duration_seconds ?? 0) / 60)} minutes`,
    });
  }

  // -- reports that finished since the last run -----------------------------
  const { data: reports } = await supabase
    .from("reports")
    .select("id, company_id, kind")
    .eq("status", "ready")
    .gte("updated_at", since);

  for (const report of reports ?? []) {
    alerts.push({
      companyId: report.company_id,
      kind: "report_ready",
      targetType: "report",
      targetId: String(report.id),
      detail: `${report.kind} report is ready to download`,
    });
  }

  if (alerts.length > 0) {
    await supabase.from("audit_log_entries").insert(
      alerts.map((alert) => ({
        company_id: alert.companyId,
        actor_id: null,
        action: `alert.${alert.kind}`,
        target_type: alert.targetType,
        target_id: alert.targetId,
        metadata: { detail: alert.detail },
      })),
    );
  }

  return json({ alerts: alerts.length });
});
