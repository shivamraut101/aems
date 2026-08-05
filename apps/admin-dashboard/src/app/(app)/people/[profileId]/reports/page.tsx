import { reportHistoryQuery } from "@/components/employee/employee-queries";
import { PrefetchBoundary } from "@/lib/server-query";

import { ReportsTabView } from "./reports-view";

/**
 * Reports tab — scope §5, narrowed to one person.
 *
 * The prefetch warms the *unnarrowed* `["reportHistory"]` entry, because that is what
 * the cache actually holds: `usePersonReports` narrows it to this employee with
 * `select`, which runs per observer and leaves the cached list alone. Warming the
 * narrowed shape instead would put a per-person payload under a company-wide key.
 */
export default async function ReportsTabPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;

  return (
    <PrefetchBoundary queries={[reportHistoryQuery]}>
      <ReportsTabView profileId={profileId} />
    </PrefetchBoundary>
  );
}
