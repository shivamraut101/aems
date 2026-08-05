import { devicesQuery } from "@/components/employee/employee-queries";
import { PrefetchBoundary } from "@/lib/server-query";

import { DevicesTabView } from "./devices-view";

/**
 * Devices tab — scope §7 and §4.4.
 *
 * A server shell over a client view, the shape every page in this app uses: the fleet
 * is fetched here, dehydrated into the HTML, and read back out of the cache by
 * `DevicesTabView`'s first render. No skeleton, no swap. See the rule at the top of
 * `lib/server-query.tsx`.
 *
 * `profileId` is passed as a prop rather than read with `useParams` in the view. The
 * server already has it, and taking it from the route here means the view does not
 * have to be mounted under this particular path to work.
 */
export default async function DevicesTabPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;

  return (
    <PrefetchBoundary queries={[devicesQuery]}>
      <DevicesTabView profileId={profileId} />
    </PrefetchBoundary>
  );
}
