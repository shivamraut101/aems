/**
 * The prompt sent to the model, and the document written back to `ai_summaries`.
 *
 * Two rules shape this file.
 *
 * 1. **Only aggregates go out.** The prompt is built from `PeriodFacts` — durations
 *    and percentages — and from nothing else. There is no code path from a window
 *    title, a URL or a screenshot to a provider request.
 * 2. **Only prose comes back.** Percentages are recorded fact; the model is given
 *    them and asked to describe them. If the model were allowed to supply the
 *    breakdown, the AI panel could contradict the timeline sitting next to it,
 *    which is the exact defect this work removes.
 */

import type { BreakdownSlice, PeriodFacts, UsageSlice } from "./aggregate.ts";
import type { SummaryKind } from "./period.ts";

export const SYSTEM_PROMPT = `You write short activity summaries for a workforce analytics product.

Write for the employee's manager, but assume the employee will also read it — this is
a transparency feature, not a report card. Describe what was worked on and how the
time was distributed. Do not speculate about motivation, effort or attitude, and do
not recommend disciplinary action about a person.

Every number in the input is already measured. Do not invent, recompute or change any
number, percentage or duration; quote them as given or describe them in words.

Reply with a single JSON object and nothing else:
{
  "summary": "Three or four sentences of plain prose. Required.",
  "observation": "One sentence naming a pattern you can see in the numbers, or null.",
  "recommendation": "One sentence of constructive, non-punitive advice, or null."
}
Use null — not an empty string — when the numbers do not support an observation or a
recommendation. Do not wrap the object in a code fence, and do not add commentary
outside it.`;

export interface InsightDocument {
  /** Bumped when the stored shape changes, so a reader can degrade instead of guess. */
  version: 1;
  summary: string;
  breakdown: BreakdownSlice[];
  observation: string | null;
  recommendation: string | null;
  activeSeconds: number;
  idleSeconds: number;
  trackedSeconds: number;
  topApps: UsageSlice[];
}

export interface ModelProse {
  summary: string;
  observation: string | null;
  recommendation: string | null;
}

export interface PromptInput {
  facts: PeriodFacts;
  kind: SummaryKind;
  /** The employee's name for daily/weekly, the company's for an insight. */
  subject: string;
}

export function buildPrompt(input: PromptInput): string {
  const { facts, kind, subject } = input;
  const startDate = facts.periodStart.slice(0, 10);
  const endDate = new Date(Date.parse(facts.periodEnd) - 1).toISOString().slice(0, 10);

  const lines: string[] = [];

  if (kind === "daily") {
    lines.push(`Day: ${startDate}`, `Employee: ${subject}`);
  } else if (kind === "weekly") {
    lines.push(`Week of ${startDate} to ${endDate}`, `Employee: ${subject}`);
  } else {
    lines.push(
      `Week of ${startDate} to ${endDate}`,
      `Company: ${subject}`,
      "Scope: every monitored employee in the company, combined.",
    );
  }

  lines.push(
    `Active time: ${formatDuration(facts.activeSeconds)}`,
    `Idle time: ${formatDuration(facts.idleSeconds)}`,
    `Tracked time: ${formatDuration(facts.trackedSeconds)}`,
  );

  if (facts.breakdown.length > 0) {
    lines.push("", "Time distribution (already measured, percentages of tracked work):");
    for (const slice of facts.breakdown) {
      lines.push(`- ${slice.label}: ${slice.percentage}%`);
    }
  }

  if (facts.topApps.length > 0) {
    lines.push("", "Application usage:");
    for (const app of facts.topApps) {
      lines.push(`- ${app.label}: ${formatDuration(app.seconds)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Reads the three prose fields out of whatever the model actually sent.
 *
 * Providers differ on whether they honour a JSON instruction, and a refusal is not
 * the only way a run can come back unusable. Anything that is not a JSON object
 * falls back to being treated as the summary, because a correct paragraph stored as
 * prose is far better than a dropped summary.
 */
export function parseModelOutput(raw: string): ModelProse {
  const text = stripFence(raw.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { summary: text, observation: null, recommendation: null };
  }

  if (!isRecord(parsed)) {
    return { summary: text, observation: null, recommendation: null };
  }

  return {
    summary: optionalString(parsed["summary"]) ?? "",
    observation: optionalString(parsed["observation"]) ?? null,
    recommendation: optionalString(parsed["recommendation"]) ?? null,
  };
}

/** Measured facts plus model prose, in the shape `ai-insight.tsx` renders. */
export function buildDocument(facts: PeriodFacts, raw: string): InsightDocument {
  const prose = parseModelOutput(raw);

  return {
    version: 1,
    summary: prose.summary,
    // Deliberately from `facts`, never from `prose` — see the file header.
    breakdown: facts.breakdown,
    observation: prose.observation,
    recommendation: prose.recommendation,
    activeSeconds: facts.activeSeconds,
    idleSeconds: facts.idleSeconds,
    trackedSeconds: facts.trackedSeconds,
    topApps: facts.topApps,
  };
}

export function formatDuration(seconds: number): string {
  // Round once, to minutes, then split. Rounding hours and minutes separately turns
  // 59m 59s into "60m", which no reader parses as an hour.
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
