import { adminClient, authorize, dayBounds, json } from "../_shared/client.ts";
import { ProviderRefusal, summarise } from "./providers.ts";

const SYSTEM = `You write short daily activity summaries for a workforce analytics product.

Write for the employee's manager, but assume the employee will also read it — this is
a transparency feature, not a report card. Describe what the person worked on and how
their time was distributed. Do not speculate about motivation, effort, or attitude,
and do not recommend disciplinary action. Three or four sentences, plain prose, no
headings or bullet points.`;

interface AppTotal {
  app: string;
  seconds: number;
}

/**
 * AI summary worker.
 *
 * Runs one summary per employee who worked yesterday. The prompt carries aggregate
 * numbers only — never window titles, URLs or screenshots — so raw monitoring data
 * is not shipped to a third-party model.
 */
Deno.serve(async (request: Request) => {
  const denied = authorize(request);
  if (denied) return denied;

  const supabase = adminClient();

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const { from, to } = dayBounds(yesterday);

  const { data: sessions, error } = await supabase
    .from("work_sessions")
    .select("company_id, profile_id")
    .gte("clock_in_at", from)
    .lt("clock_in_at", to);

  if (error) return json({ error: error.message }, 500);

  const people = new Map<string, string>();
  for (const session of sessions ?? []) {
    people.set(session.profile_id, session.company_id);
  }

  const written: string[] = [];
  const failed: { profileId: string; reason: string }[] = [];

  for (const [profileId, companyId] of people) {
    try {
      const [{ data: activity }, { data: idle }] = await Promise.all([
        supabase
          .from("activity_events")
          .select("app_name, category, started_at, ended_at")
          .eq("profile_id", profileId)
          .gte("started_at", from)
          .lt("started_at", to),
        supabase
          .from("idle_events")
          .select("duration_seconds")
          .eq("profile_id", profileId)
          .gte("idle_start_at", from)
          .lt("idle_start_at", to),
      ]);

      const totals = new Map<string, number>();
      const windowEnd = Date.parse(to);

      for (const event of activity ?? []) {
        const start = Date.parse(event.started_at);
        const end = event.ended_at ? Date.parse(event.ended_at) : windowEnd;
        const seconds = Math.max(0, Math.round((end - start) / 1000));
        totals.set(event.app_name, (totals.get(event.app_name) ?? 0) + seconds);
      }

      const topApps: AppTotal[] = [...totals.entries()]
        .map(([app, seconds]) => ({ app, seconds }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 8);

      const idleSeconds = (idle ?? []).reduce(
        (sum, row) => sum + (row.duration_seconds ?? 0),
        0,
      );
      const activeSeconds = topApps.reduce((sum, app) => sum + app.seconds, 0);

      if (activeSeconds === 0) continue;

      const prompt = [
        `Date: ${from.slice(0, 10)}`,
        `Active time: ${formatDuration(activeSeconds)}`,
        `Idle time: ${formatDuration(idleSeconds)}`,
        "",
        "Application usage:",
        ...topApps.map((app) => `- ${app.app}: ${formatDuration(app.seconds)}`),
      ].join("\n");

      const result = await summarise({ system: SYSTEM, prompt });

      await supabase.from("ai_summaries").insert({
        company_id: companyId,
        profile_id: profileId,
        kind: "daily",
        period_start: from,
        period_end: to,
        provider: result.provider,
        model: result.model,
        content: result.content,
      });

      written.push(profileId);
    } catch (err) {
      // One provider refusal or transient error must not abort the whole batch.
      const reason = err instanceof ProviderRefusal ? `refused: ${err.category}` : String(err);
      failed.push({ profileId, reason });
    }
  }

  return json({ written: written.length, failed });
});

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
