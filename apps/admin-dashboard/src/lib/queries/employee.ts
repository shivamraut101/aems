"use client";

/**
 * Data for the employee detail page.
 *
 * Its own file rather than an addition to `lib/api.ts`: the shared module is the fetch
 * layer and the shell's session hook, and every screen adding its own hooks to it makes
 * one file every screen has to touch.
 *
 * Business data comes from the Fastify API. The Supabase browser client is for the auth
 * session and realtime only — see CLAUDE.md's data-flow rule.
 */

import { useQuery } from "@tanstack/react-query";
import type { DayTimeline } from "@aems/types";

import { apiFetch } from "@/lib/api";

/** One device row, exactly as `GET /api/employees/:profileId` returns it. */
export interface EmployeeDevice {
  id: string;
  company_id: string;
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

/** `GET /api/employees/:profileId` — a profile row with its devices joined. */
export interface EmployeeDetail {
  id: string;
  company_id: string;
  email: string;
  full_name: string;
  role: "super_admin" | "manager" | "employee";
  department: string | null;
  manager_id: string | null;
  monitoring_enabled: boolean;
  created_at: string;
  devices: EmployeeDevice[];
}

/**
 * Identity and devices for one person.
 *
 * `retry: false` because both failures are settled facts: a 404 for an id that is not
 * in this company, a 403 for an employee asking about somebody else. Retrying either
 * only delays the message.
 */
export function useEmployee(profileId: string) {
  return useQuery({
    queryKey: ["employee", profileId],
    queryFn: () => apiFetch<EmployeeDetail>(`/api/employees/${encodeURIComponent(profileId)}`),
    enabled: Boolean(profileId),
    // Names, roles and departments do not change while somebody reads a page.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The grid every view on this page shares. Ten minutes, per the API's fixed set. */
export const DAY_SLOT_SECONDS = 600;

/** How often a day still in progress is refreshed. Totals age slower than presence. */
const LIVE_REFRESH_MS = 60_000;

/**
 * One person's whole day, reduced server-side.
 *
 * Deliberately keyed `["timeline", profileId, from, to, bucketSeconds]` — the
 * convention every tab on this page uses — so the Overview and the Timeline tab share
 * one response instead of fetching the same day twice.
 *
 * A finished day is immutable, so it is cached indefinitely; only a day still running
 * is polled. Without that distinction, paging back through last week would re-request
 * every day on every window focus.
 */
export function useEmployeeDay(
  profileId: string,
  from: string,
  to: string,
  bucketSeconds: number = DAY_SLOT_SECONDS,
) {
  const inProgress = Date.parse(to) > Date.now();

  return useQuery({
    queryKey: ["timeline", profileId, from, to, bucketSeconds],
    queryFn: () =>
      apiFetch<DayTimeline>(
        `/api/analytics/timeline?profileId=${encodeURIComponent(profileId)}` +
          `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          `&bucketSeconds=${bucketSeconds}`,
      ),
    enabled: Boolean(profileId && from && to),
    staleTime: inProgress ? 30_000 : Infinity,
    ...(inProgress ? { refetchInterval: LIVE_REFRESH_MS } : {}),
    // A 403 here means an employee asked for someone else's day. That is an answer,
    // not an outage.
    retry: false,
  });
}
