"use client";

import type { ReportDocument, ReportRow } from "@aems/analytics";
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

import { apiQuery, specRequestInit, specResult, type ApiQuerySpec } from "./query-spec";
import { apiBaseUrl, joinUrl, parseMeResponse, type Session } from "./session";
import { createClient } from "./supabase";

export { joinUrl };
export { apiQuery, type ApiQuerySpec };

/**
 * The shared fetch layer for every client component in the dashboard.
 *
 * Two rules hold everything together:
 *
 *  1. Business data comes from the Fastify API, never from Supabase. The Supabase
 *     browser client appears here only to read (and silently refresh) the access
 *     token, and elsewhere only for realtime.
 *  2. A failure is described to the person, not to the developer. Before this file
 *     existed a 401 rendered as "check that the API is running" — an authentication
 *     problem reported as an outage, which sends the user to the wrong place.
 */

/** The API answered, and the answer was a refusal. Resending it changes nothing. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The API's own wording. Developer copy — logged, never rendered for 401/403. */
  readonly serverMessage: string | null;

  constructor(message: string, status: number, code: string, serverMessage: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

/**
 * The request never got an answer — offline, DNS, refused connection, aborted.
 *
 * A sibling of {@link ApiError} rather than a subclass, mirroring the SDK: these are
 * the two halves of "is retrying meaningful?", and collapsing them is how a dropped
 * Wi-Fi connection ends up telling someone their session expired.
 */
export class NetworkError extends Error {
  readonly status = null;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkError";
  }
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

function readErrorBody(body: unknown): ApiErrorBody | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as ApiErrorBody;
  const code = typeof candidate.error === "string" ? candidate.error : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : undefined;
  if (code === undefined && message === undefined) return null;
  return { ...(code !== undefined && { error: code }), ...(message !== undefined && { message }) };
}

/**
 * Turns an HTTP status into a sentence a person can act on.
 *
 * 401 and 403 deliberately discard the server's wording: "Missing bearer token" and
 * "Manager role required" are true and useless. 400 keeps it, because a 400 is about
 * the request the user just made and the server is the only thing that knows why.
 */
export function apiErrorFor(status: number, body: unknown): ApiError {
  const parsed = readErrorBody(body);
  const code = parsed?.error ?? "unknown";
  const serverMessage = parsed?.message ?? null;
  const generic = "That request could not be completed.";

  let message: string;
  if (status === 401) {
    message = "Your session expired. Sign in again.";
  } else if (status === 403) {
    message = "You do not have access to this.";
  } else if (status === 404) {
    message = "That record could not be found.";
  } else if (status === 429) {
    message = "Too many requests. Wait a moment and try again.";
  } else if (status >= 500) {
    message = "The service is temporarily unavailable. Try again in a moment.";
  } else if (status === 400 || status === 409 || status === 422) {
    message = serverMessage ?? generic;
  } else {
    message = generic;
  }

  return new ApiError(message, status, code, serverMessage);
}

/** The one error signing out actually fixes. Everything else would just re-throw. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** The sentence to render for a failed query. Use this instead of `error.message`. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof NetworkError) return "Could not reach the service. Check your connection.";
  return "Something went wrong.";
}

/**
 * Reads the current access token, refreshing it if it has expired.
 *
 * `getSession()` performs the refresh itself and writes the rotated tokens back to
 * the cookie store, which is why the token is read per request rather than captured
 * once — a client holding a token from page load goes stale after an hour.
 */
async function accessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await createClient().auth.getSession();

  return session?.access_token ?? null;
}

/**
 * Calls the Fastify API with the signed-in user's token.
 *
 * Throws {@link ApiError} when the API refused and {@link NetworkError} when the
 * request never landed. Both carry copy fit to render — see {@link describeError}.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  if (!token) {
    // No point spending a round trip to be told what we already know, and the copy
    // for "signed out" is the same either way.
    throw apiErrorFor(401, { error: "unauthorized", message: "No local session" });
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(joinUrl(apiBaseUrl(), path), { ...init, headers });
  } catch (cause) {
    throw new NetworkError(`${path} never reached the API`, { cause });
  }

  if (!response.ok) {
    throw apiErrorFor(response.status, await safeJson(response));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Retry only the failures a second attempt can change.
 *
 * An {@link ApiError} is the API's considered answer. A 401 does not become a 200
 * on a resend, a 403 does not become permission, a 404 does not become a record and
 * a 429 answered by immediately asking again is the thing 429 exists to stop. React
 * Query's default retries all three, so every settled refusal cost a doubled round
 * trip before the screen was allowed to say what had happened — and during it the
 * UI shows its loading state, which reads as "working" rather than "refused".
 *
 * A {@link NetworkError} is the opposite case: nothing answered at all, so trying
 * again is exactly right. That split is why the two are separate classes.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  return !(error instanceof ApiError) && failureCount < 2;
}

// ---------------------------------------------------------------------------
// The client half of the server-prefetch pattern
// ---------------------------------------------------------------------------

/**
 * Turns an {@link ApiQuerySpec} into TanStack options.
 *
 * The counterpart of `serverApiQuery` in `supabase-server.ts`: same key, same path,
 * same `parse`, different token source. A page that uses one and prefetches with the
 * other cannot desynchronise them, because there is only one declaration to change.
 *
 * Exported for the few callers that need the options object itself — `fetchQuery`
 * during sign-in, or an `enabled`-gated variant. Prefer {@link useApiQuery}.
 */
export function apiQueryOptions<T>(spec: ApiQuerySpec<T>) {
  return {
    queryKey: spec.queryKey,
    queryFn: async (): Promise<T> =>
      specResult(spec, await apiFetch<unknown>(spec.path, specRequestInit(spec))),
    retry: retryUnlessRefused,
    ...(spec.staleTime !== undefined ? { staleTime: spec.staleTime } : {}),
  };
}

/**
 * Reads a declared query.
 *
 * If the route's `page.tsx` listed this same spec in its `PrefetchBoundary`, the
 * answer is already in the cache when this first runs: `isLoading` is false, no
 * skeleton is drawn, and the real content is in the first paint. If it did not, this
 * behaves exactly like any other query and the page's loading state is honest.
 *
 * `overrides` is for the query *behaviour* — `enabled`, `refetchInterval`,
 * `placeholderData`. It must never carry `queryKey` or `queryFn`; those come from
 * the spec, which is the point of the spec.
 */
export function useApiQuery<T>(
  spec: ApiQuerySpec<T>,
  overrides?: Omit<UseQueryOptions<T, Error, T>, "queryKey" | "queryFn">,
) {
  return useQuery<T, Error, T>({ ...apiQueryOptions(spec), ...overrides });
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * The signed-in person.
 *
 * Declared as a spec so the root layout can answer it server-side and seed the cache
 * before a single component renders. That seeding is what stops the sidebar painting
 * four placeholder bars and then swapping to the real navigation — for an employee
 * that swap went from four rows to one, which is the flash the client reported.
 *
 * `staleTime` is generous because identity does not change under someone mid-session
 * and the shell must not re-request it on every window focus.
 */
export const SESSION_QUERY = apiQuery<Session | null>({
  queryKey: ["session"],
  path: "/api/auth/me",
  parse: parseMeResponse,
  staleTime: 5 * 60_000,
});

/**
 * {@link SESSION_QUERY} as options, with retries off.
 *
 * The two ways this fails — no session, no profile linked to the account — are both
 * settled facts that a second attempt cannot change. Kept as an exported object so
 * the sign-in form can `fetchQuery` the very same cache entry.
 */
export const sessionQuery = {
  ...apiQueryOptions(SESSION_QUERY),
  retry: false as const,
};

/**
 * The signed-in person, from cache.
 *
 * Never in a loading state on a normal page render: `app/layout.tsx` resolves the
 * profile on the server and hands it to `Providers`, which writes it into the query
 * cache at construction — before the first render, not after it.
 */
export function useSession() {
  return useQuery<Session | null>(sessionQuery);
}

/**
 * One row of `GET /api/analytics/live` — one per PERSON, not per device.
 *
 * The three device fields are null for someone who has enrolled nothing. They
 * used to be non-null because the endpoint was driven by `devices`, which meant
 * a person without one simply never appeared in the strip; `profileId` is the
 * stable identity here and is what the table keys on.
 */
export interface LiveWorkforceRow {
  deviceId: string | null;
  platform: "windows" | "macos" | "android" | null;
  label: string | null;
  profileId: string;
  fullName: string | null;
  email: string | null;
  lastSeenAt: string | null;
  /** Set only while `status` is "idle" — when the current idle stretch began. */
  idleSince: string | null;
  /**
   * `finished` means they clocked out today and nothing is open again — see the
   * derivation in `analytics.ts`. It is a kind of offline that says why.
   */
  status: "active" | "idle" | "finished" | "offline";
}

export interface OverviewMetrics {
  totalEmployees: number;
  activeNow: number;
  workingToday: number;
  totalHoursToday: number;
}

export function useOverview() {
  return useQuery({
    queryKey: ["analytics", "overview"],
    queryFn: () => apiFetch<OverviewMetrics>("/api/analytics/overview"),
    retry: retryUnlessRefused,
  });
}

export function useLiveWorkforce() {
  return useQuery({
    queryKey: ["analytics", "live"],
    queryFn: () => apiFetch<LiveWorkforceRow[]>("/api/analytics/live"),
    // The live strip is the one place staleness is actually visible to the user.
    refetchInterval: 20_000,
    retry: retryUnlessRefused,
  });
}

export function useEmployees() {
  return useQuery({
    queryKey: ["employees"],
    queryFn: () => apiFetch<EmployeeRow[]>("/api/employees"),
    retry: retryUnlessRefused,
  });
}

export interface EmployeeRow {
  id: string;
  email: string;
  full_name: string;
  role: "super_admin" | "manager" | "employee";
  department: string | null;
  manager_id: string | null;
  monitoring_enabled: boolean;
  created_at: string;
  devices: {
    id: string;
    platform: "windows" | "macos" | "android";
    label: string;
    status: "active" | "offline" | "revoked";
    last_seen_at: string | null;
  }[];
}

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: () => apiFetch<DeviceRow[]>("/api/devices"),
    retry: retryUnlessRefused,
  });
}

export interface DeviceRow {
  id: string;
  profile_id: string;
  platform: "windows" | "macos" | "android";
  label: string;
  device_name: string;
  os_version: string;
  agent_version: string;
  model: string | null;
  cpu: string | null;
  ram_mb: number | null;
  storage_mb: number | null;
  status: "active" | "offline" | "revoked";
  last_seen_at: string | null;
  enrolled_at: string;
  /**
   * The machine this person's working hours are computed from (migration …0016).
   *
   * At most one per person. When none is set, the day is the union across all their
   * devices — which is what every day before this was computed with.
   */
  is_primary: boolean;
}

// ---------------------------------------------------------------------------
// Activity intelligence — the dashboard home's charts and its work-pattern KPI
// ---------------------------------------------------------------------------

/**
 * These read `POST /api/reports/run` at company scope rather than a bespoke
 * aggregate, for the same reason the employee Apps and Websites tabs do: that
 * endpoint is the only place in the product where per-app and per-day time is
 * merged per person before it is summed. A second aggregation path for the home
 * page is precisely how the worker and the dashboard came to disagree about the
 * same day once already.
 *
 * No new endpoint was invented for this, and none is needed. `/` is a manager-only
 * destination (see `session.ts` NAV) and `/api/reports/run` pins an employee to
 * their own data server-side, so company scope here can only ever be answered for
 * someone entitled to it.
 */

const DAY_MS = 86_400_000;

/** A half-open instant window. Empty strings mean "the local clock is not known yet". */
export interface Period {
  from: string;
  to: string;
}

/**
 * Local midnight `days - 1` days ago, through now.
 *
 * Local rather than UTC because the reader picked neither — they just opened the
 * page, and "the last seven days" means seven of *their* days. The end is nudged a
 * second past the start for the one instant a day where they coincide: the API
 * refuses a zero-width period with a 400, and a dashboard that breaks at midnight
 * is a dashboard that breaks on the night shift.
 */
export function trailingDays(days: number, now: Date): Period {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Math.max(0, days - 1));

  const end = Math.max(now.getTime(), start.getTime() + 1000);
  return { from: start.toISOString(), to: new Date(end).toISOString() };
}

/** Local midnight through now — the window every "today" figure on the page shares. */
export function todaySoFar(now: Date): Period {
  return trailingDays(1, now);
}

/**
 * The same trailing window, aligned to whole UTC days.
 *
 * The per-day report buckets by UTC day (`aggregate.ts` `dayWindows`), and a window
 * that starts at the reader's midnight starts *inside* one of those buckets for
 * everyone not on UTC. Asked for seven local days from Delhi, the report answered
 * eight buckets whose first held five and a half hours — and a five-and-a-half-hour
 * bucket drawn beside seven full ones reads as a quiet day rather than as a sliver
 * of one. Aligning the request to the grid the answer uses is what makes the chart's
 * bars comparable to each other.
 *
 * The final bucket is still partial, because it is today and today is not over.
 */
export function trailingUtcDays(days: number, now: Date): Period {
  const end = now.getTime();
  const start = Math.floor(end / DAY_MS) * DAY_MS - Math.max(0, days - 1) * DAY_MS;

  return {
    from: new Date(start).toISOString(),
    to: new Date(Math.max(end, start + 1000)).toISOString(),
  };
}

interface CompanyReportSpec {
  kind: "time_and_activity" | "app_usage";
  grouping: "date" | "application";
  scope: "company";
  decimalDuration: false;
}

/**
 * One company-scope report run, cached by its own period.
 *
 * `enabled` is off until the period is resolved. The home page derives its window
 * from the *browser's* clock, which a server-rendered first paint does not have —
 * firing before then would ask about a window nobody chose and be answered 400.
 */
function useCompanyReport(spec: CompanyReportSpec, period: Period | null) {
  const from = period?.from ?? "";
  const to = period?.to ?? "";

  return useQuery({
    queryKey: ["company-report", spec.kind, spec.grouping, from, to],
    queryFn: () =>
      apiFetch<ReportDocument>("/api/reports/run", {
        method: "POST",
        body: JSON.stringify({ ...spec, periodStart: from, periodEnd: to }),
      }),
    enabled: from !== "" && to !== "",
    // An aggregate over a week does not change meaningfully between two glances at
    // the same screen, and this is the most expensive call the page makes.
    staleTime: 5 * 60_000,
    retry: retryUnlessRefused,
  });
}

/** Time in each application across the company — scope §2.4, aggregated. */
export function useCompanyAppUsage(period: Period | null) {
  return useCompanyReport(
    { kind: "app_usage", grouping: "application", scope: "company", decimalDuration: false },
    period,
  );
}

/** Focused / idle / break per day across the company — the work pattern, over time. */
export function useCompanyWorkPattern(period: Period | null) {
  return useCompanyReport(
    { kind: "time_and_activity", grouping: "date", scope: "company", decimalDuration: false },
    period,
  );
}

function cellNumber(row: ReportRow | null | undefined, id: string): number {
  const value = row?.cells[id];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cellText(row: ReportRow | null | undefined, id: string): string {
  const value = row?.cells[id];
  return typeof value === "string" ? value : "";
}

/**
 * A column from the document's totals row.
 *
 * The totals row is the *merged* figure, not the sum of the rows above it — two
 * devices reporting the same hour count once. That distinction is the whole reason
 * the aggregator emits a totals row separately, so a caller wanting a headline
 * number must read it rather than adding up the table.
 */
export function reportTotal(document: ReportDocument | undefined, columnId: string): number {
  return cellNumber(document?.sections[0]?.totals, columnId);
}

export interface AppUsageBar {
  label: string;
  seconds: number;
  /** 0..1 of the company's merged tracked time. */
  share: number;
}

/**
 * The busiest applications, with the tail folded into one row.
 *
 * Folding rather than truncating: a chart that silently drops the eleventh app
 * implies the ten shown are the whole day. `limit` counts the folded row, so the
 * chart never renders more bars than it was asked for.
 */
export function appUsageBars(document: ReportDocument | undefined, limit = 6): AppUsageBar[] {
  const bars: AppUsageBar[] = [];

  for (const row of document?.sections[0]?.rows ?? []) {
    const label = cellText(row, "application");
    const seconds = cellNumber(row, "duration");
    if (label === "" || seconds <= 0) continue;
    bars.push({ label, seconds, share: cellNumber(row, "share") });
  }

  // The API already sorts busiest-first; sorting again makes this function correct
  // on its own rather than correct only downstream of one particular caller.
  bars.sort((a, b) => b.seconds - a.seconds);

  if (limit < 1 || bars.length <= limit) return bars;

  const head = bars.slice(0, limit - 1);
  const tail = bars.slice(limit - 1);

  head.push({
    label: `${tail.length} other apps`,
    seconds: tail.reduce((sum, bar) => sum + bar.seconds, 0),
    share: tail.reduce((sum, bar) => sum + bar.share, 0),
  });

  return head;
}

export interface WorkPatternDay {
  /** The UTC day key the aggregator bucketed by, e.g. "2026-08-05". */
  key: string;
  /** Short axis label — "Wed 5". Derived from UTC parts, never re-read locally. */
  label: string;
  focusedSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
  trackedSeconds: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Labelled from UTC parts: the keys are UTC days, and re-reading one locally shifts it. */
function utcDayLabel(instant: number): string {
  const date = new Date(instant);
  return `${WEEKDAYS[date.getUTCDay()] ?? ""} ${date.getUTCDate()}`;
}

/**
 * One entry per day in the window, including the days nobody worked.
 *
 * The aggregator drops a day whose tracked time is zero, which is right for a table
 * and wrong for a trend: a chart built straight from those rows puts Monday next to
 * Friday and draws a continuous week out of two working days. The gaps are the
 * finding, so they are rendered as gaps.
 *
 * The day grid is rebuilt with the same UTC floor the aggregator uses
 * (`aggregate.ts` `dayWindows`), so the keys line up exactly rather than nearly.
 */
export function workPatternDays(document: ReportDocument | undefined): WorkPatternDay[] {
  if (!document) return [];

  const start = Date.parse(document.periodStart);
  const end = Date.parse(document.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const byDate = new Map<string, ReportRow>();
  for (const row of document.sections[0]?.rows ?? []) {
    const key = cellText(row, "date");
    if (key !== "") byDate.set(key, row);
  }

  const days: WorkPatternDay[] = [];
  let cursor = Math.floor(start / DAY_MS) * DAY_MS;

  // Bounded so a malformed period cannot spin here, and so an accidental year-long
  // window cannot try to render 365 bars.
  for (let guard = 0; cursor < end && guard < 92; guard += 1) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    const row = byDate.get(key) ?? null;

    days.push({
      key,
      label: utcDayLabel(cursor),
      focusedSeconds: cellNumber(row, "active"),
      idleSeconds: cellNumber(row, "idle"),
      breakSeconds: cellNumber(row, "break"),
      trackedSeconds: cellNumber(row, "tracked"),
    });

    cursor += DAY_MS;
  }

  return days;
}
