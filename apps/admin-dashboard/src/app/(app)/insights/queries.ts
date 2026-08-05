import type { AiSummaryRow, InsightKind } from "@/lib/queries/insights";
import { apiQuery, type ApiQuerySpec } from "@/lib/query-spec";

/**
 * The AI summary read, declared once for both sides of the render.
 *
 * The key and the path are byte-identical to the ones `useInsights()` builds in
 * `lib/queries/insights.ts`, and that matters beyond this screen: the dashboard home
 * reads `useInsights("insight")` under the same key, so warming it here also warms the
 * panel on `/`. A key invented for this page would fetch the same row twice and let the
 * two copies age apart.
 *
 * No `"use client"` — `page.tsx` imports this. Everything from `lib/queries/insights` is
 * `import type` and erased; a *value* imported from that module could not be called
 * from a server component at all, which is why the parameter reading below is
 * reimplemented here rather than borrowed from it.
 */

const KINDS: readonly InsightKind[] = ["daily", "weekly", "insight"];

/** Loose enough to reject a typo, strict enough not to reimplement the API's schema. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Summaries of one kind, for one person or for the company.
 *
 * A factory rather than a constant because the question this screen asks changes with
 * the controls: `["insights", kind, profileId ?? "company"]` is the cache key, and
 * `"company"` stands in for the null profile so a company row and a person's row can
 * never collide under an `undefined` segment.
 */
export function insightsQuery(
  kind: InsightKind,
  profileId: string | null,
): ApiQuerySpec<AiSummaryRow[]> {
  return apiQuery<AiSummaryRow[]>({
    queryKey: ["insights", kind, profileId ?? "company"],
    path: `/api/analytics/insights?kind=${kind}${profileId ? `&profileId=${profileId}` : ""}`,
    // Summaries are written once per period by a scheduled worker.
    staleTime: 5 * 60_000,
  });
}

/** `?kind=`, or null when it names nothing. */
export function readInsightKindParam(raw: string | string[] | undefined): InsightKind | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  return KINDS.includes(value as InsightKind) ? (value as InsightKind) : null;
}

/**
 * `?profileId=`, or null when it is not a profile id.
 *
 * Shape-checked before it is used to build a cache key. The API answers 400 for
 * anything else, which a prefetch would spend a round trip discovering and then cache
 * nothing from — so the check saves a request rather than adding a rule.
 */
export function readProfileIdParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/**
 * Which summary a request is asking for, and whether it can be asked at all.
 *
 * `askable` is the `enabled` gate in one place: a daily or weekly summary needs a
 * person, and asking for one without naming them is a malformed request the API refuses
 * (`insightsSchema` in `routes/analytics.ts`) rather than an empty result.
 */
export function resolveInsightsRequest(input: {
  kindParam: string | string[] | undefined;
  profileIdParam: string | string[] | undefined;
  /** The default when `?kind=` names nothing — the first kind the role is offered. */
  fallbackKind: InsightKind;
  /** Set for an employee, who may only ever read their own. Overrides the parameter. */
  ownProfileId: string | null;
}): { kind: InsightKind; profileId: string | null; askable: boolean } {
  const kind = readInsightKindParam(input.kindParam) ?? input.fallbackKind;

  // The company row has `profile_id = null`; pinning it to a person would filter it out
  // of its own result set.
  const profileId =
    kind === "insight" ? null : (input.ownProfileId ?? readProfileIdParam(input.profileIdParam));

  return { kind, profileId, askable: kind === "insight" || profileId !== null };
}
