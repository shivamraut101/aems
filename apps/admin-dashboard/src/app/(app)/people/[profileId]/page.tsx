import { Suspense } from "react";

import { OverviewTab } from "@/components/employee/overview-tab";

import { OverviewFallback } from "./overview-fallback";

/**
 * The Overview tab — scope §4.4's first section, and the default landing for
 * `/people/:id`.
 *
 * Shows §2.2's block (work time, active, idle) and docs/design.md's Work Pattern —
 * "Focused time 7h 20m", not "86%". The design document is explicit that a bare
 * productivity score reads as invasive; the categorisation rules are what make the
 * descriptive version computable.
 */
export default async function EmployeeOverviewPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;

  return (
    // Never `null`. An empty tab body in the prerendered HTML reads as a route that
    // failed, and it is the first thing anyone opening a person sees.
    <Suspense fallback={<OverviewFallback />}>
      <OverviewTab profileId={profileId} />
    </Suspense>
  );
}
