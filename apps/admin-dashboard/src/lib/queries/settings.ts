"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, type EmployeeRow } from "@/lib/api";

import type { PolicyRecord } from "./settings-view";

/**
 * Data hooks for /settings.
 *
 * Both endpoints go through the Fastify API. The policy is company configuration and
 * the monitoring toggle is the highest-privilege write in the product; neither may
 * take the Supabase shortcut, because the API is where the audit log is written.
 */

/**
 * The policy version currently in force.
 *
 * `retry: false` because every way this fails is settled: 404 means the company has
 * not published a policy yet, 403 means this role may not read one. Retrying a
 * settled fact three times only delays the answer.
 *
 * NOTE: `GET /api/policies/current` is not implemented yet — see the gap reported
 * with this work. Until it exists the request 404s, which is deliberately the same
 * answer as "no policy published", so the screen already renders the right thing:
 * the setup prompt, not a failure box.
 */
export function useCompanyPolicy() {
  return useQuery<PolicyRecord | null>({
    queryKey: ["policy", "current"],
    queryFn: () => apiFetch<PolicyRecord | null>("/api/policies/current"),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export interface MonitoringChange {
  profileId: string;
  enabled: boolean;
}

/**
 * Turns collection on or off for one person.
 *
 * Deliberately **not** optimistic. Everywhere else an optimistic update is a
 * courtesy; here the switch position is a statement about whether someone is being
 * monitored right now, and showing "paused" before the server has agreed would be
 * the one lie this product cannot tell. The row moves when the API says it moved.
 */
export function useSetMonitoring() {
  const queryClient = useQueryClient();

  return useMutation<EmployeeRow, unknown, MonitoringChange>({
    mutationFn: ({ profileId, enabled }) =>
      apiFetch<EmployeeRow>(`/api/employees/${profileId}`, {
        method: "PATCH",
        body: JSON.stringify({ monitoringEnabled: enabled }),
      }),
    onSuccess: () => {
      // The roster feeds People, Settings and the employee header; refetch it rather
      // than patching three caches by hand and letting one of them drift.
      void queryClient.invalidateQueries({ queryKey: ["employees"] });
    },
    retry: false,
  });
}
