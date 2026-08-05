"use client";

import { useQuery } from "@tanstack/react-query";

import { ApiError, apiFetch } from "@/lib/api";
import type { UserRole } from "@/lib/session";

/**
 * The AI surface's data layer.
 *
 * The worker writes a JSON document into `ai_summaries.content`, but rows written
 * before that change hold flat prose — so every read goes through {@link readInsight},
 * which degrades rather than guesses. The one rule this file exists to enforce is the
 * separation of *measured* seconds from *modelled* sentences: they arrive in the same
 * row and must not render as the same kind of claim.
 */

export type InsightKind = "daily" | "weekly" | "insight";

/** A row of `ai_summaries`, straight from the table. */
export interface AiSummaryRow {
  id: number;
  company_id: string;
  /** Null for the company-wide `insight` row. */
  profile_id: string | null;
  kind: string;
  period_start: string;
  period_end: string;
  provider: string;
  model: string;
  content: string;
  created_at: string;
}

export interface InsightBreakdownEntry {
  label: string;
  percentage: number;
}

export interface InsightMeasured {
  activeSeconds: number;
  idleSeconds: number;
  trackedSeconds: number;
  topApps: { label: string; seconds: number }[];
}

export interface InsightView {
  summary: string;
  breakdown: InsightBreakdownEntry[];
  observation: string | null;
  recommendation: string | null;
  /**
   * Recorded activity, not model output. Null for a row that predates the structured
   * document — in which case the screen has nothing measured to show and says so
   * rather than borrowing numbers out of the prose.
   */
  measured: InsightMeasured | null;
  /** False when the document was unreadable or came from a version we do not know. */
  structured: boolean;
}

const EMPTY: InsightView = {
  summary: "",
  breakdown: [],
  observation: null,
  recommendation: null,
  measured: null,
  structured: false,
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBreakdown(value: unknown): InsightBreakdownEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: InsightBreakdownEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const label = asString((item as { label?: unknown }).label);
    const percentage = asFiniteNumber((item as { percentage?: unknown }).percentage);
    if (label === null || percentage === null) continue;
    entries.push({ label, percentage });
  }
  return entries;
}

function readTopApps(value: unknown): { label: string; seconds: number }[] {
  if (!Array.isArray(value)) return [];

  const apps: { label: string; seconds: number }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const label = asString((item as { label?: unknown }).label);
    const seconds = asFiniteNumber((item as { seconds?: unknown }).seconds);
    if (label === null || seconds === null) continue;
    apps.push({ label, seconds });
  }
  return apps;
}

/**
 * Turns stored content into something renderable, whatever shape it is in.
 *
 * Three cases, all real: the current version 1 document, a flat prose blob from
 * before the worker was changed, and — the case worth writing down — a document from
 * a *later* version. That last one takes the summary and nothing else, because
 * rendering fields whose meaning may have changed is how a panel starts lying.
 */
export function readInsight(content: string): InsightView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A row written before the worker emitted JSON. The whole cell is the summary.
    return { ...EMPTY, summary: content.trim() };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...EMPTY, summary: content.trim() };
  }

  const document = parsed as Record<string, unknown>;
  const summary = asString(document["summary"]) ?? "";

  if (document["version"] !== 1) {
    return { ...EMPTY, summary };
  }

  const activeSeconds = asFiniteNumber(document["activeSeconds"]);
  const idleSeconds = asFiniteNumber(document["idleSeconds"]);
  const trackedSeconds = asFiniteNumber(document["trackedSeconds"]);

  return {
    summary,
    // A document with no summary is not a document. Marking it unstructured sends
    // the screen down its "nothing to show" path instead of rendering an empty panel.
    structured: summary.length > 0,
    breakdown: readBreakdown(document["breakdown"]),
    observation: asString(document["observation"]),
    recommendation: asString(document["recommendation"]),
    measured:
      activeSeconds === null || idleSeconds === null || trackedSeconds === null
        ? null
        : {
            activeSeconds,
            idleSeconds,
            trackedSeconds,
            topApps: readTopApps(document["topApps"]),
          },
  };
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formatted from UTC parts rather than through `toLocaleDateString`.
 *
 * The worker's periods are UTC day and UTC week boundaries; re-reading them in the
 * browser's zone would label a UTC Monday as Sunday for anyone west of Greenwich.
 */
function utcDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCFullYear()}`;
}

export function periodLabel(kind: string, periodStart: string, _periodEnd?: string): string {
  return kind === "daily" ? utcDayLabel(periodStart) : `Week of ${utcDayLabel(periodStart)}`;
}

/** Newest period first. Copies rather than sorting the query cache's own array. */
export function sortByPeriodDesc(rows: AiSummaryRow[]): AiSummaryRow[] {
  return [...rows].sort((a, b) => Date.parse(b.period_start) - Date.parse(a.period_start));
}

/* -------------------------------------------------------------------------- */
/* Role gating and availability                                                */
/* -------------------------------------------------------------------------- */

export interface InsightKindOption {
  value: InsightKind;
  label: string;
  /** One line explaining what the model was given, shown under the control. */
  description: string;
}

const COMPANY_INSIGHT: InsightKindOption = {
  value: "insight",
  label: "Company",
  description: "One weekly reading across everyone in the company.",
};

const WEEKLY: InsightKindOption = {
  value: "weekly",
  label: "Weekly",
  description: "One person's week, Monday to Monday.",
};

const DAILY: InsightKindOption = {
  value: "daily",
  label: "Daily",
  description: "One person's day.",
};

/**
 * Which summaries a role may read.
 *
 * The company row has `profile_id = null`, which fails the employee RLS policy
 * (`profile_id = auth.uid()`), so offering it to an employee would be offering a
 * refusal.
 */
export function kindOptionsForRole(role: UserRole): InsightKindOption[] {
  return role === "employee" ? [DAILY, WEEKLY] : [COMPANY_INSIGHT, WEEKLY, DAILY];
}

/**
 * Is this failure "the summaries read path does not exist yet"?
 *
 * `GET /api/analytics/insights` is specified by the AI worker's contract and is not
 * implemented in `routes/analytics.ts` at the time of writing. A 404 there is an
 * unfinished backend, not something the reader did — so the screen shows its empty
 * state instead of an error banner. Every other status stays an error.
 */
export function isInsightsUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export function useInsights(kind: InsightKind, profileId?: string | null) {
  return useQuery({
    queryKey: ["insights", kind, profileId ?? "company"],
    queryFn: () =>
      apiFetch<AiSummaryRow[]>(
        `/api/analytics/insights?kind=${kind}${profileId ? `&profileId=${profileId}` : ""}`,
      ),
    // A daily summary for a person who has none, or a route that is not deployed,
    // are both settled answers.
    retry: false,
    // Summaries are written once per period by a scheduled worker.
    staleTime: 5 * 60_000,
    enabled: kind === "insight" || Boolean(profileId),
  });
}
