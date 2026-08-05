/**
 * Which window a run covers, and which `kind` row it writes.
 *
 * `kind` used to be the literal string "daily" at the insert site, even though
 * `ai_summaries`'s check constraint has always permitted daily, weekly and insight
 * and scope §6 asks for all three. It is a parameter of the job now, so one
 * deployed function serves three schedules.
 */

export type SummaryKind = "daily" | "weekly" | "insight";

export const SUMMARY_KINDS: readonly SummaryKind[] = ["daily", "weekly", "insight"] as const;

export interface Period {
  kind: SummaryKind;
  /** Inclusive ISO-8601 UTC instant. */
  start: string;
  /** Exclusive ISO-8601 UTC instant. */
  end: string;
}

export interface JobRequest {
  kind: SummaryKind;
  /** The moment the job is considered to run at; periods are measured back from it. */
  reference: Date;
}

const DAY_MS = 86_400_000;

/**
 * A period is always *complete* at the time it is summarised — never the day or
 * week in progress. A summary of a partial day would be re-generated with different
 * numbers on the next run and would disagree with itself, which is worse than
 * arriving a few hours later.
 */
export function resolvePeriod(kind: SummaryKind, reference: Date): Period {
  if (kind === "daily") {
    const end = startOfUtcDay(reference);
    return { kind, start: iso(end - DAY_MS), end: iso(end) };
  }

  // weekly and insight share a window: the same seven days, one scoped to a person
  // and one to the whole company, so a manager can read them side by side.
  const end = startOfIsoWeek(reference);
  return { kind, start: iso(end - 7 * DAY_MS), end: iso(end) };
}

export function parseJobRequest(url: string, body: unknown): JobRequest {
  const params = new URL(url).searchParams;
  const record = isRecord(body) ? body : {};

  const rawKind = firstString(record["kind"]) ?? params.get("kind") ?? "daily";
  if (!isSummaryKind(rawKind)) {
    throw new Error(`kind must be one of daily, weekly, insight (got "${rawKind}")`);
  }

  const rawDate = firstString(record["date"]) ?? params.get("date");
  if (rawDate === null || rawDate === undefined) {
    return { kind: rawKind, reference: new Date() };
  }

  const parsed = Date.parse(rawDate);
  if (!Number.isFinite(parsed)) {
    // Falling back to "now" here would silently summarise the wrong window and
    // then upsert over a correct row, so a bad date has to be loud.
    throw new Error(`date must be an ISO-8601 date (got "${rawDate}")`);
  }

  return { kind: rawKind, reference: new Date(parsed) };
}

export function isSummaryKind(value: unknown): value is SummaryKind {
  return typeof value === "string" && (SUMMARY_KINDS as readonly string[]).includes(value);
}

function startOfUtcDay(reference: Date): number {
  return Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
}

/** Midnight UTC on the Monday of `reference`'s ISO week. */
function startOfIsoWeek(reference: Date): number {
  const day = reference.getUTCDay();
  // getUTCDay() puts Sunday at 0; ISO weeks start on Monday, so Sunday is day 7.
  const offset = day === 0 ? 6 : day - 1;
  return startOfUtcDay(reference) - offset * DAY_MS;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
