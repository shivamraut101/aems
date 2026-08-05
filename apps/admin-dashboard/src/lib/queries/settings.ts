"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch, useApiQuery, type EmployeeRow } from "@/lib/api";

import { categoryRulesQuery, companyPolicyQuery } from "./settings-specs";
import type {
  CategoryRuleDto,
  CategoryRuleInput,
  PolicyPublishInput,
  PolicyRecord,
} from "./settings-view";

/**
 * Data hooks for /settings.
 *
 * Every one of these goes through the Fastify API. The policy and the classification
 * rules are company configuration and the monitoring toggle is the highest-privilege
 * write in the product; none may take the Supabase shortcut, because the API is where
 * the audit log is written.
 *
 * The two reads take their key and path from `settings-specs.ts` rather than declaring
 * them here, because `settings/page.tsx` warms the same objects on the server. A hook
 * that restated `["policy", "current"]` inline would agree with the prefetch today and
 * silently stop agreeing the first time either gained a parameter — and the symptom of
 * that is the skeleton flash coming back with nothing reporting an error.
 */

/**
 * The policy version currently in force.
 *
 * `GET /api/policies/current` is `requireUser`, not manager-gated — everyone signed in
 * may read the terms they are monitored under — and it deliberately answers `200 null`
 * for a company that has not published yet. `policyState` maps both that and a 404 onto
 * "missing", so the screen shows the publish form either way rather than a red box.
 *
 * `retry: false` because every way this fails is settled: an expired session and a
 * missing profile are both facts a second attempt cannot change.
 */
export function useCompanyPolicy() {
  return useApiQuery(companyPolicyQuery, { retry: false });
}

/**
 * Publishes a new policy version.
 *
 * A publish, never an edit. Consent is recorded against a policy version
 * (non-negotiable #1), so mutating the row an employee consented to would rewrite
 * what they agreed to after the fact. `POST /api/policies` inserts; the newest row by
 * `created_at` is what `/current` and device enrolment both read.
 */
export function usePublishPolicy() {
  const queryClient = useQueryClient();

  return useMutation<PolicyRecord, unknown, PolicyPublishInput>({
    mutationFn: (input) =>
      apiFetch<PolicyRecord>("/api/policies", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (policy) => {
      // Seed the cache with what the server stored, then refetch. Writing the
      // response in means the panel shows the *stored* row — including any value the
      // server normalised — rather than the draft that was typed.
      queryClient.setQueryData(["policy", "current"], policy);
      void queryClient.invalidateQueries({ queryKey: ["policy"] });
    },
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
    onSuccess: (_row, variables) => {
      // The roster feeds People, Settings and the employee header; refetch it rather
      // than patching three caches by hand and letting one of them drift.
      void queryClient.invalidateQueries({ queryKey: ["employees"] });
      // The employee header states "Monitoring: on" from its own query, and the live
      // strip counts who is being collected from. Both are now wrong for this person.
      void queryClient.invalidateQueries({ queryKey: ["employee", variables.profileId] });
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------

/**
 * The company's classification rules, in evaluation order, with the engine's refusals.
 *
 * Readable by every role — the API says so, and an employee is entitled to see the
 * rules being applied to their own activity.
 */
export function useCategoryRules() {
  return useApiQuery(categoryRulesQuery, { retry: false });
}

/**
 * Everything a rule change invalidates.
 *
 * Categorisation is recomputed on read from the rules in force, so editing one rule
 * changes what every activity screen, usage table, report and AI insight says about
 * history that was already recorded. Invalidating only the rule list would leave the
 * rest of the product showing the previous classification until a reload.
 */
function invalidateEverythingCategorised(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["categories"] });
  void queryClient.invalidateQueries({ queryKey: ["usage"] });
  void queryClient.invalidateQueries({ queryKey: ["timeline"] });
  void queryClient.invalidateQueries({ queryKey: ["insights"] });
  void queryClient.invalidateQueries({ queryKey: ["analytics"] });
}

export function useCreateCategoryRule() {
  const queryClient = useQueryClient();

  return useMutation<CategoryRuleDto, unknown, CategoryRuleInput>({
    mutationFn: (input) =>
      apiFetch<CategoryRuleDto>("/api/activity/categories", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateEverythingCategorised(queryClient),
    retry: false,
  });
}

export interface CategoryRuleEdit {
  id: string;
  input: CategoryRuleInput;
}

export function useUpdateCategoryRule() {
  const queryClient = useQueryClient();

  return useMutation<CategoryRuleDto, unknown, CategoryRuleEdit>({
    mutationFn: ({ id, input }) =>
      apiFetch<CategoryRuleDto>(`/api/activity/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateEverythingCategorised(queryClient),
    retry: false,
  });
}

/**
 * Deletes a rule.
 *
 * History keeps the label stored on each row until something recategorises it, so
 * this is not a retroactive erasure — it is a change to what happens from now on, and
 * to what a recomputing read decides.
 */
export function useDeleteCategoryRule() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, string>({
    mutationFn: (id) =>
      apiFetch<void>(`/api/activity/categories/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateEverythingCategorised(queryClient),
    retry: false,
  });
}
