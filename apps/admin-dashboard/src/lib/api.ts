"use client";

import { useQuery } from "@tanstack/react-query";

import { apiBaseUrl, joinUrl, parseMeResponse, type Session } from "./session";
import { createClient } from "./supabase";

export { joinUrl };

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
// Query hooks
// ---------------------------------------------------------------------------

/**
 * The signed-in person.
 *
 * `retry: false` because the two ways this fails — no session, no profile linked to
 * the account — are both settled facts that a second attempt cannot change.
 */
export function useSession() {
  return useQuery<Session | null>({
    queryKey: ["session"],
    queryFn: async () => parseMeResponse(await apiFetch<unknown>("/api/auth/me")),
    // Identity does not change under someone mid-session; the shell should not
    // re-request it on every window focus.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export interface LiveWorkforceRow {
  deviceId: string;
  platform: "windows" | "macos" | "android";
  label: string;
  profileId: string | null;
  fullName: string | null;
  email: string | null;
  lastSeenAt: string | null;
  /** Set only while `status` is "idle" — when the current idle stretch began. */
  idleSince: string | null;
  status: "active" | "idle" | "offline";
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
  });
}

export function useLiveWorkforce() {
  return useQuery({
    queryKey: ["analytics", "live"],
    queryFn: () => apiFetch<LiveWorkforceRow[]>("/api/analytics/live"),
    // The live strip is the one place staleness is actually visible to the user.
    refetchInterval: 20_000,
  });
}

export function useEmployees() {
  return useQuery({
    queryKey: ["employees"],
    queryFn: () => apiFetch<EmployeeRow[]>("/api/employees"),
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
}
