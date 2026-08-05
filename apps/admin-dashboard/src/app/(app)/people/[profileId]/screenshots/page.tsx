import type { Metadata } from "next";

import { ScreenshotReview } from "@/components/screenshot-review";

export const metadata: Metadata = {
  title: "Screenshots — AEMS",
};

/** `YYYY-MM-DD`, and nothing else. The value reaches a query string and a Date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readDate(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  // A well-formed but impossible date ("2026-02-31") would silently roll over into
  // March and label the page with a day the reviewer did not ask for.
  return Number.isNaN(Date.parse(`${value}T00:00:00`)) ? null : value;
}

function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The Screenshots tab of the employee page — scope §4.4, §2.3.
 *
 * A thin server shell: it resolves which person and which day, and hands both to a
 * client component that owns the fetching. The signed URLs on this screen live ten
 * minutes, so the data has to be able to re-sign itself while the page is open;
 * server-rendering the tiles would hand the reviewer a page that quietly rots. For
 * the same reason the blocks are not prefetched — their window is the viewer's local
 * midnight clamped to the current ten-minute block, which is a key the server cannot
 * predict (rule 2 in `lib/server-query.tsx`).
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
  searchParams,
}: {
  params: Promise<{ profileId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profileId } = await params;
  const requestedDate = readDate((await searchParams)["date"]);

  const serverToday = today();

  return (
    <ScreenshotReview
      profileId={profileId}
      date={requestedDate ?? serverToday}
      today={serverToday}
      dateWasExplicit={requestedDate !== null}
    />
  );
}
