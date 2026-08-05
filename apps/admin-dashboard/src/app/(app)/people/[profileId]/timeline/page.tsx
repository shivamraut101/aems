"use client";

import { useParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { ActivityTimeline, TimelineSkeleton } from "@/components/activity-timeline";
import { SectionHeading } from "@/components/employee/states";
import { useDayWindow } from "@/components/employee/use-day-window";
import { clampWindowToNow } from "@/components/timeline/model";
import { useDayTimeline } from "@/lib/queries/timeline";

/**
 * How often the live day is re-read.
 *
 * Also the reason it is five minutes and not more: the screenshot URLs inside the
 * payload are signed for ten, so the window has to move — and the query key with it —
 * before the tiles on screen expire.
 */
const CLOCK_INTERVAL_MS = 5 * 60_000;

/**
 * Timeline tab — scope §2.7, and the surface `docs/design.md` calls the product's
 * differentiator.
 *
 * The page is only a wiring layer. The day comes from the shared control in the page
 * chrome so all seven tabs agree about which day they are showing, the reduction has
 * already happened server-side in `@aems/analytics`, and every state the screen can be
 * in — loading, refused, empty — belongs to `ActivityTimeline` so it reads identically
 * wherever the timeline is mounted.
 *
 * `useDayWindow` reads `useSearchParams`, which forces a Suspense boundary during
 * prerender, so the tab itself is a child component.
 */
export default function TimelinePage() {
  return (
    <Suspense fallback={<TimelineSkeleton />}>
      <TimelineTab />
    </Suspense>
  );
}

function TimelineTab() {
  const params = useParams();
  const profileId = typeof params?.["profileId"] === "string" ? params["profileId"] : "";

  const day = useDayWindow();

  /*
   * The clock is a value in state, not a `new Date()` per render.
   *
   * The window feeds the query key, so reading the clock during render would mint a
   * new key on every render and refetch forever. Resolving it after mount also keeps
   * the server render (another machine, almost certainly UTC) from hydrating into a
   * different day than the browser would have drawn.
   */
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const window = day && now ? clampWindowToNow({ from: day.from, to: day.to }, now) : null;
  // A window clamped to a point is a day that has not begun. Asking the API about it
  // would spend a round trip to be told what the calendar already said.
  const notStarted = window !== null && window.from === window.to;

  const query = useDayTimeline(profileId, window?.from ?? "", window?.to ?? "");

  return (
    <div>
      <SectionHeading
        title="Timeline"
        hint={
          // Stated rather than assumed. Every clock label here is the *viewer's*, and
          // a manager in one timezone reading an employee in another has no way to
          // know that unless it is written down. (`profiles.timezone` is the real
          // fix — priority matrix #35, after the demo.) Appended only once mounted,
          // because the server renders in a different zone than the browser.
          day
            ? `Where the time went, and the moments inside it. Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`
            : "Where the time went, and the moments inside it."
        }
      />

      {day === null || window === null ? (
        <TimelineSkeleton />
      ) : (
        <ActivityTimeline
          timeline={notStarted ? null : query.data}
          isLoading={query.isPending && query.fetchStatus === "fetching"}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          emptyHint={
            notStarted
              ? `${day.label} has not started yet.`
              : `Nothing reached the server for ${day.label}. Activity appears here once the agent opens a session.`
          }
        />
      )}
    </div>
  );
}
