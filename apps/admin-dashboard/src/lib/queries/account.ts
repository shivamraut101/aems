/**
 * The three reads behind the employee's own product — /me, /my-devices, /account.
 *
 * Declared as {@link ApiQuerySpec}s rather than hooks so each screen's `page.tsx` can
 * warm them on the server and the client hook can read the warmed entry, from one
 * declaration. See the rule at the top of `lib/server-query.tsx`.
 *
 * **Every key here is deliberately the key an existing hook already uses**, and that is
 * the point rather than a coincidence:
 *
 *  - `["devices"]` is `useDevices()` in `lib/api.ts`, same path, same payload.
 *  - `["policy", "current"]` is `useCompanyPolicy()` in `lib/queries/settings.ts`.
 *  - `["employee", profileId]` is `useEmployee()` in `lib/queries/employee.ts`.
 *
 * Colliding on purpose means a manager who opens /account and then a person's detail
 * page is served one cached profile instead of two copies that can disagree. It also
 * means **nothing here may `parse` its payload**: a spec that reshaped the body would
 * store a different object under a key another hook writes raw, and whichever landed
 * second would silently change what the other screen rendered. Normalisation happens
 * at render time instead — see `resolveManager` in `components/me/account-model.ts`.
 *
 * No `"use client"`: a server `page.tsx` imports these, and the directive would drag
 * this module (and everything it names) across the boundary for no reason.
 */

import type { DeviceRow } from "@/lib/api";
import type { PolicyRecord } from "@/lib/queries/settings-view";
import { apiQuery } from "@/lib/query-spec";
import type { UserRole } from "@/lib/session";

/**
 * `GET /api/devices`, as the route actually answers it.
 *
 * `DeviceRow` in `lib/api.ts` predates the telemetry embed the route now flattens onto
 * every row, so it is widened here rather than edited there — that type is read by the
 * manager inventory, which is owned elsewhere this week.
 *
 * For an employee the route filters to `profile_id = session.profileId` server-side. It
 * does **not** for a manager or an admin, who get the whole company — so a screen about
 * "my" devices must still filter. `ownDevices` below is that filter, in one place.
 */
export interface MyDeviceRow extends DeviceRow {
  telemetry?: {
    recorded_at: string;
    battery_level: number | null;
    battery_charging: boolean | null;
    network_type: string | null;
    storage_free_mb: number | null;
    screen_active_seconds: number | null;
  } | null;
}

/**
 * Every device this reader may see.
 *
 * `staleTime` is short: "last reported 20 seconds ago" is the one number on the page
 * that is worth being current, and it is the number that tells someone their agent has
 * stopped.
 */
export const myDevicesQuery = apiQuery<MyDeviceRow[]>({
  queryKey: ["devices"],
  path: "/api/devices",
  staleTime: 30_000,
});

/**
 * The monitoring policy in force for the company.
 *
 * `GET /api/policies/current` is `requireUser`, not manager-gated, and deliberately so:
 * the screenshot interval and the idle threshold are the terms a person is monitored
 * under, and a product that hides them from the monitored is the framing
 * `docs/design.md` rules out. It answers `200 null` for a company that has published
 * nothing, which is a real answer and not an error.
 */
export const currentPolicyQuery = apiQuery<PolicyRecord | null>({
  queryKey: ["policy", "current"],
  path: "/api/policies/current",
  staleTime: 5 * 60_000,
});

/** One device as `GET /api/employees/:profileId` embeds it. */
export interface AccountDevice {
  id: string;
  platform: "windows" | "macos" | "android";
  label: string;
  device_name: string;
  status: "active" | "offline" | "revoked";
  last_seen_at: string | null;
  enrolled_at: string;
}

/**
 * The signed-in person's own profile row.
 *
 * `manager` is optional because the API does **not** send it today — `/api/employees/
 * :profileId` selects `*, devices(*)` and nothing else, and an employee cannot look the
 * name up themselves (RLS `profiles_select_self` is exactly one row: their own). It is
 * declared, and accepted in both shapes PostgREST emits for a join, so that the day the
 * embed is added the Account page shows a name with no dashboard change. Until then
 * `resolveManager` reports the honest "assigned, name not available here".
 */
export interface AccountManager {
  id: string;
  full_name: string | null;
  email: string;
}

export interface AccountProfile {
  id: string;
  company_id: string;
  email: string;
  full_name: string;
  role: UserRole;
  department: string | null;
  manager_id: string | null;
  monitoring_enabled: boolean;
  created_at: string;
  deactivated_at?: string | null;
  devices?: AccountDevice[];
  manager?: AccountManager | AccountManager[] | null;
}

/**
 * One person's profile.
 *
 * `GET /api/employees/:profileId` allows a caller to read **themselves** whatever their
 * role (`profileId !== session.profileId && !canViewOthers(role)` is the only refusal),
 * which is what makes this usable as the Account page's read rather than needing a new
 * endpoint. Asking for anybody else's id is a 403, so this must only ever be called
 * with the id from the session.
 */
export function accountQuery(profileId: string) {
  return apiQuery<AccountProfile>({
    queryKey: ["employee", profileId],
    path: `/api/employees/${encodeURIComponent(profileId)}`,
    staleTime: 5 * 60_000,
  });
}

/*
 * Nothing else belongs in this file. The pure view models that consume these payloads
 * — which devices are mine, what each one records, what consent is in force — live in
 * `components/me/*` beside their tests, because this module is imported by server
 * components and must stay a declaration of reads rather than a place logic accretes.
 */
