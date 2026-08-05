import { ApiError } from "@/lib/api";

/**
 * View models for /settings.
 *
 * The compliance-critical copy lives here rather than inline in JSX so it can be
 * asserted: a monitoring toggle whose wording does not state what stops, what is
 * kept and when it takes effect is a defect, not a styling choice.
 */

/** `policies` as the table stores it — snake_case, straight from the row. */
export interface PolicyRecord {
  id: string;
  company_id: string;
  version: string;
  name: string;
  screenshot_interval_seconds: number;
  idle_threshold_seconds: number;
  tracked_categories: string[];
  created_at: string;
  updated_at: string;
}

/** The five intervals `docs/scope.md` §2.3 names. Not a free-text number. */
export const SCREENSHOT_INTERVAL_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 1800, label: "30 min" },
];

/**
 * A duration in the words a policy uses.
 *
 * Separate from `lib/format.ts`'s `duration()`, which renders worked time ("7h 20m")
 * and drops seconds. A 30-second idle threshold is a legal value here, and rounding
 * it away would show two different policies as the same policy.
 */
export function intervalLabel(seconds: number): string {
  if (seconds <= 0) return "—";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (rest > 0) parts.push(`${rest} sec`);

  return parts.join(" ");
}

/** Captures over an eight-hour day — the number that makes an interval concrete. */
export function screenshotsPerDay(intervalSeconds: number): number {
  if (intervalSeconds <= 0) return 0;
  return Math.floor((8 * 3600) / intervalSeconds);
}

export type PolicyState = "loading" | "ready" | "missing" | "forbidden" | "error";

/**
 * Which of five things the policy panel is looking at.
 *
 * `missing` exists so that a company which has simply not published a policy yet —
 * every company, on day one — is told to publish one instead of being shown a red
 * failure box. That distinction is the difference between an empty product and a
 * broken one, and a demo starts empty.
 */
export function policyState(query: {
  isLoading: boolean;
  error: unknown;
  data: PolicyRecord | null | undefined;
}): PolicyState {
  if (query.isLoading) return "loading";

  if (query.error) {
    if (query.error instanceof ApiError) {
      if (query.error.status === 404) return "missing";
      if (query.error.status === 403) return "forbidden";
    }
    return "error";
  }

  return query.data ? "ready" : "missing";
}

export interface MonitoringCopy {
  action: string;
  detail: string;
}

/**
 * What the per-employee monitoring toggle promises.
 *
 * Three obligations are written into these two sentences. Non-negotiable #4 —
 * revocation takes effect on the agent's next request, not "eventually". Data
 * already collected is retained, because a toggle is not a delete. And resuming
 * still runs through consent, because `monitoring_enabled` is a company control and
 * consent is the employee's — turning collection back on does not re-consent for
 * them.
 */
export function monitoringConsequence(enabled: boolean): MonitoringCopy {
  if (enabled) {
    return {
      action: "Pause monitoring",
      detail:
        "The agent stops collecting activity, screenshots and app usage on its next check-in. Data already recorded is kept and stays visible in reports.",
    };
  }

  return {
    action: "Resume monitoring",
    detail:
      "Collection restarts on the next check-in, provided this person's consent for the device is still in force. Nothing from the paused period is recovered.",
  };
}
