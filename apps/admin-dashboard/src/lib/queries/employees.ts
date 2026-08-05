"use client";

/**
 * Reads and writes against `/api/employees` — scope §4.2, "add employee, remove
 * employee, assign department, assign manager, enable/disable monitoring".
 *
 * Every one of these goes through the Fastify API rather than the Supabase browser
 * client, and not only because CLAUDE.md's data-flow rule says so: the API is where
 * `recordAudit` runs, and a role change that leaves no audit row is a compliance
 * defect, not a shortcut. Creation could not go through Supabase at all — it needs
 * the admin auth API, which needs the service-role key.
 *
 * None of the writes is optimistic. The things they change — somebody's role, their
 * manager, whether their machine is collecting, whether their account exists — are
 * statements about a real person that must not be shown as true before the server has
 * agreed. `useSetMonitoring` in `settings.ts` made that call first; this file keeps it.
 */

import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { apiFetch, type EmployeeRow } from "@/lib/api";

import type { CreateEmployeeBody, UpdateEmployeeBody } from "./employees-form";

/**
 * The roster, optionally including people who have been off-boarded.
 *
 * `GET /api/employees` hides deactivated profiles unless asked, which is right for
 * every ordinary view and wrong for exactly one: without a way to list them, a
 * deactivated person is unreachable, and the page that could bring them back is the
 * page you can no longer navigate to.
 *
 * The default branch is byte-identical to `useEmployees` — same key, same URL — so
 * the common case shares one cache entry with the rest of the dashboard rather than
 * fetching the roster twice.
 */
export function useRoster(includeDeactivated: boolean) {
  return useQuery({
    queryKey: includeDeactivated ? ["employees", "withDeactivated"] : ["employees"],
    queryFn: () =>
      apiFetch<EmployeeRow[]>(
        includeDeactivated ? "/api/employees?includeDeactivated=true" : "/api/employees",
      ),
  });
}

/**
 * Everything a write to one profile invalidates.
 *
 * The roster feeds People, Settings and the employee header; the detail entry feeds
 * the page chrome; the live board and the device table both carry a name, a device
 * state and a monitoring state that an off-boarding changes. `["employees"]` is a
 * prefix, so it catches the `withDeactivated` variant too. Refetching all four is
 * cheaper to keep correct than patching four caches by hand and letting one drift —
 * which is how a "monitoring paused" badge survives on a page after it was resumed.
 */
function invalidatePerson(queryClient: ReturnType<typeof useQueryClient>, profileId?: string) {
  void queryClient.invalidateQueries({ queryKey: ["employees"] });
  void queryClient.invalidateQueries({ queryKey: ["devices"] });
  void queryClient.invalidateQueries({ queryKey: ["analytics", "live"] });
  if (profileId) void queryClient.invalidateQueries({ queryKey: ["employee", profileId] });
}

/** `POST /api/employees` — 201, with the profile and a password shown exactly once. */
export interface CreatedEmployee {
  profile: EmployeeRow;
  /**
   * The generated first password, or null when the admin chose one themselves.
   *
   * The API returns this once and stores it nowhere. No mail is configured, so this
   * string is the *only* way the new person can ever sign in — a dialog that
   * discards it silently creates an account nobody can use.
   */
  temporaryPassword: string | null;
}

/**
 * Add a person — the action the product did not have.
 *
 * Until this existed the roster's zero-row state told an administrator to go and
 * create the account in the Supabase console, which is a database credential handed
 * out as a feature.
 */
export function useCreateEmployee(): UseMutationResult<CreatedEmployee, unknown, CreateEmployeeBody> {
  const queryClient = useQueryClient();

  return useMutation<CreatedEmployee, unknown, CreateEmployeeBody>({
    mutationFn: (body) =>
      apiFetch<CreatedEmployee>("/api/employees", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (created) => invalidatePerson(queryClient, created?.profile?.id),
    // A duplicate address is a 409, an unusable manager a 400. Both are settled
    // answers about the request that was just made; resending changes neither. And
    // a blind retry of a create is how two accounts appear for one person.
    retry: false,
  });
}

export interface EmployeeUpdate {
  profileId: string;
  patch: UpdateEmployeeBody;
}

/** `PATCH /api/employees/:profileId` — name, department, manager, role, monitoring. */
export function useUpdateEmployee(): UseMutationResult<EmployeeRow, unknown, EmployeeUpdate> {
  const queryClient = useQueryClient();

  return useMutation<EmployeeRow, unknown, EmployeeUpdate>({
    mutationFn: ({ profileId, patch }) =>
      apiFetch<EmployeeRow>(`/api/employees/${encodeURIComponent(profileId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, variables) => invalidatePerson(queryClient, variables.profileId),
    retry: false,
  });
}

/** What `DELETE /api/employees/:profileId` reports it did. */
export interface DeactivationResult {
  ok: true;
  profile: EmployeeRow;
  devicesRevoked: number;
  consentRecordsRevoked: number;
}

/**
 * Off-board somebody. Soft, always.
 *
 * Non-negotiable #4 is that revocation is immediate and #5 is that the record
 * survives it, and the endpoint honours both: it sets the tombstone, pauses
 * monitoring, revokes every device and withdraws every live consent record, while
 * leaving each session, event and capture exactly where it is. The confirm step in
 * the UI says all of that in those words, because "Remove" with no explanation reads
 * as "erase their history".
 */
export function useDeactivateEmployee(): UseMutationResult<DeactivationResult, unknown, string> {
  const queryClient = useQueryClient();

  return useMutation<DeactivationResult, unknown, string>({
    mutationFn: (profileId) =>
      apiFetch<DeactivationResult>(`/api/employees/${encodeURIComponent(profileId)}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, profileId) => invalidatePerson(queryClient, profileId),
    retry: false,
  });
}

/** What `POST /api/employees/:profileId/reactivate` reports it did. */
export interface ReactivationResult {
  ok: true;
  profile: EmployeeRow;
  /** Deliberately still false. Consent was withdrawn during off-boarding. */
  monitoringEnabled: boolean;
  devicesRestored: number;
}

/**
 * Bring somebody back.
 *
 * Narrow by design: it clears the tombstone and nothing else. Monitoring stays off
 * and the devices stay revoked, because consent was withdrawn when the person was
 * off-boarded and non-negotiable #1 forbids collection resuming without a fresh
 * record. Re-enrolling the agent is what produces one — so the dialog says so rather
 * than letting an administrator assume the machine started collecting again.
 */
export function useReactivateEmployee(): UseMutationResult<ReactivationResult, unknown, string> {
  const queryClient = useQueryClient();

  return useMutation<ReactivationResult, unknown, string>({
    mutationFn: (profileId) =>
      apiFetch<ReactivationResult>(
        `/api/employees/${encodeURIComponent(profileId)}/reactivate`,
        { method: "POST" },
      ),
    onSuccess: (_data, profileId) => invalidatePerson(queryClient, profileId),
    retry: false,
  });
}
