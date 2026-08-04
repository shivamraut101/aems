import { adminClient, authorize, json } from "../_shared/client.ts";

interface Interval {
  start: number;
  end: number;
}

/** Same merge rule the dashboard uses — overlapping spans must not double-count. */
function merge(intervals: Interval[]): Interval[] {
  const valid = intervals.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function seconds(intervals: Interval[]): number {
  return Math.round(merge(intervals).reduce((sum, i) => sum + (i.end - i.start), 0) / 1000);
}

/**
 * Report worker.
 *
 * Picks up rows the API queued as `pending`, renders a CSV, stores it, and flips the
 * row to `ready`. A row that throws is marked `failed` rather than left pending, so
 * a broken report never looks like a slow one.
 */
Deno.serve(async (request: Request) => {
  const denied = authorize(request);
  if (denied) return denied;

  const supabase = adminClient();

  const { data: queued, error } = await supabase
    .from("reports")
    .select("*")
    .eq("status", "pending")
    .order("created_at")
    .limit(10);

  if (error) return json({ error: error.message }, 500);

  const results: { id: number; status: string }[] = [];

  for (const report of queued ?? []) {
    try {
      let query = supabase
        .from("activity_events")
        .select("profile_id, app_name, category, started_at, ended_at")
        .eq("company_id", report.company_id)
        .gte("started_at", report.period_start)
        .lte("started_at", report.period_end);

      if (report.profile_id) query = query.eq("profile_id", report.profile_id);

      const { data: events } = await query;

      const byProfile = new Map<string, Map<string, Interval[]>>();
      const periodEnd = Date.parse(report.period_end);

      for (const event of events ?? []) {
        const apps = byProfile.get(event.profile_id) ?? new Map<string, Interval[]>();
        const spans = apps.get(event.app_name) ?? [];
        spans.push({
          start: Date.parse(event.started_at),
          end: event.ended_at ? Date.parse(event.ended_at) : periodEnd,
        });
        apps.set(event.app_name, spans);
        byProfile.set(event.profile_id, apps);
      }

      const rows = ["profile_id,app_name,seconds"];
      for (const [profileId, apps] of byProfile) {
        for (const [appName, spans] of apps) {
          // Quote the app name — window titles contain commas often enough.
          rows.push(`${profileId},"${appName.replace(/"/g, '""')}",${seconds(spans)}`);
        }
      }

      const path = `${report.company_id}/${report.profile_id ?? "company"}/reports/${report.kind}-${report.id}.csv`;

      const { error: uploadError } = await supabase.storage
        .from("aems")
        .upload(path, new Blob([rows.join("\n")], { type: "text/csv" }), {
          contentType: "text/csv",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      await supabase
        .from("reports")
        .update({ status: "ready", storage_path: path })
        .eq("id", report.id);

      results.push({ id: report.id, status: "ready" });
    } catch (err) {
      await supabase.from("reports").update({ status: "failed" }).eq("id", report.id);
      results.push({ id: report.id, status: `failed: ${String(err)}` });
    }
  }

  return json({ processed: results });
});
