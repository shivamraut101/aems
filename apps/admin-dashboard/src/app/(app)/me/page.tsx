import { Suspense } from "react";

import { MyActivity } from "@/components/me/my-activity";
import { MeShell } from "@/components/me/me-shell";
import { PanelSkeleton } from "@/components/states";
import { currentPolicyQuery } from "@/lib/queries/account";
import { PrefetchBoundary } from "@/lib/server-query";

export const metadata = {
  title: "My activity",
};

/**
 * `/me` — the destination every role carries in the sidebar, and where an employee
 * lands after signing in (`landingPathForRole`).
 *
 * A server component that warms one query. The day itself deliberately is **not**
 * prefetched: it is keyed on the reader's local midnight and on `?date=`, which the
 * server does not know (rule 2 in `lib/server-query.tsx`) — the server would warm a key
 * the browser never asks for and the page would pay for the round trip twice. The
 * policy has no such dependency, so the "what is being collected" panel is real content
 * in the first paint rather than a panel that appears a beat later.
 *
 * Suspense because `useDayWindow` reads `useSearchParams`, which suspends during the
 * static render; without a boundary the whole route opts out of prerendering. The
 * fallback is the real shell rather than `null`, so nothing collapses and jumps.
 */
export default function MyActivityPage() {
  return (
    <PrefetchBoundary queries={[currentPolicyQuery]}>
      <Suspense fallback={<MyActivityFallback />}>
        <MyActivity />
      </Suspense>
    </PrefetchBoundary>
  );
}

function MyActivityFallback() {
  return (
    <MeShell title="My activity" subtitle="Everything recorded about your work.">
      <PanelSkeleton minHeightClass="min-h-[20rem]" lines={4} label="Loading your day" />
    </MeShell>
  );
}
