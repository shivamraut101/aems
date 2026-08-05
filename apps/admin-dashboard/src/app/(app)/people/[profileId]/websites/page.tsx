import { devicesQuery } from "@/components/employee/employee-queries";
import { PrefetchBoundary } from "@/lib/server-query";

import { WebsitesTabView } from "./websites-view";

/**
 * Websites tab — scope §2.5.
 *
 * Only the fleet is prefetched, and it is the important half: the coverage note on
 * this tab explains why the list below it may be nearly empty (Windows cannot report
 * a browser's address bar), and a caveat that arrives *after* the short list it
 * explains has already been read is a caveat nobody reads.
 *
 * The usage table itself is not prefetched. Its window is the viewer's local midnight
 * — see rule 2 in `lib/server-query.tsx` and the note in
 * `components/employee/employee-queries.ts` — so the server cannot know which key the
 * browser is going to ask for.
 */
export default async function WebsitesTabPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;

  return (
    <PrefetchBoundary queries={[devicesQuery]}>
      <WebsitesTabView profileId={profileId} />
    </PrefetchBoundary>
  );
}
