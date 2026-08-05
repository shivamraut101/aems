import { PrefetchBoundary } from "@/lib/server-query";

import { liveWorkforceQuery, overviewQuery } from "./home-queries";
import { OverviewView } from "./overview-view";

/**
 * Dashboard home — scope §4.1.
 *
 * The server half of the two-file page shape described at the top of
 * `lib/server-query.tsx`. It fetches the headline metrics and the live board into a
 * request-scoped query cache, dehydrates them into the HTML, and renders nothing of
 * its own; `overview-view.tsx` is the page that used to be here, unchanged except for
 * its name and for reading those two through their specs.
 *
 * The two prefetches run in parallel, so the page costs the slower of them rather
 * than their sum. Neither is keyed on anything the browser knows and the server does
 * not — which is exactly why these two and not the trailing-week charts, whose window
 * starts at the reader's own midnight.
 *
 * A signed-in employee never reaches this file: `landingRedirectFor` in the root
 * layout moves them to `/me` before any HTML is written, because "/" is the manager
 * Overview and sign-in used to leave them staring at a permission wall.
 */
export default function OverviewPage() {
  return (
    <PrefetchBoundary queries={[overviewQuery, liveWorkforceQuery]}>
      <OverviewView />
    </PrefetchBoundary>
  );
}
