import type { Metadata } from "next";
import { Suspense } from "react";

import { ScreenshotReview, ScreenshotReviewSkeleton } from "@/components/screenshot-review";

export const metadata: Metadata = {
  title: "Screenshots — AEMS",
};

/**
 * The Screenshots tab of the employee page — scope §4.4, §2.3.
 *
 * A thin server shell: it resolves which person, and hands that to a client component
 * that owns the fetching. The signed URLs on this screen live ten minutes, so the data
 * has to be able to re-sign itself while the page is open; server-rendering the tiles
 * would hand the reviewer a page that quietly rots. For the same reason the blocks are
 * not prefetched — their window is the viewer's local midnight clamped to the current
 * ten-minute block, which is a key the server cannot predict (rule 2 in
 * `lib/server-query.tsx`).
 *
 * **The day is no longer resolved here.** This file used to parse `?date=` and compute
 * the server's own "today", then hand both down as props for the review to hold in
 * state — which made this the one tab whose day did not follow the day control in the
 * employee header. The day belongs to the URL and `useDayWindow` reads it, exactly as
 * the other six tabs do, so `searchParams` is not this page's business any more.
 *
 * `useDayWindow` reads `useSearchParams`, which forces a Suspense boundary during
 * prerender — the same reason the Timeline tab has one.
 *
 * **No `serverApiFetch` here any more.** This file used to call
 * `/api/employees/:profileId` itself, on the server, for one string — the lightbox
 * caption — while the route's layout was already prefetching that exact record for
 * the header above it. Two identical requests per page view, and two places a name
 * could come from. `ScreenshotReview` reads it out of the hydrated cache instead.
 *
 * No auth guard here on purpose. Middleware owns the redirect and AppShell renders
 * the refusal panel for a role that cannot reach /people — and the API refuses
 * anyway, which is the boundary that actually counts.
 */
export default async function ScreenshotsPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;

  return (
    <Suspense fallback={<ScreenshotReviewSkeleton />}>
      <ScreenshotReview profileId={profileId} />
    </Suspense>
  );
}
