import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { EmployeeHeader } from "@/components/employee/employee-header";
import { employeeQuery, rosterQuery } from "@/components/employee/employee-queries";
import { EmployeeTabs } from "@/components/employee/employee-tabs";
import { PrefetchBoundary } from "@/lib/server-query";

import { EmployeeActions } from "./employee-actions";

/**
 * The employee detail page — scope §4.4.
 *
 * Chrome only: the identity header, the day control and the tab strip. Each of the
 * seven sections is a nested route rather than a piece of local state, which is what
 * makes every one of them a link a manager can paste into a message, makes browser
 * back work, and lets the employee transparency view (`/me`) reuse these components
 * with `profileId` pinned to the session instead of being a second implementation.
 *
 * **The person is resolved on the server.** `PrefetchBoundary` warms
 * `/api/employees/:id` and the roster into the request's own query cache and
 * dehydrates them into the HTML, so `EmployeeHeader` renders the real name, role,
 * device and status in the *first* paint. Before this the page painted a grey circle
 * and two grey bars, hydrated, fired the request, and swapped — on the most visited
 * screen in the product. The roster rides along because `EmployeeActions` reads it to
 * turn `manager_id` into a name, and a second waterfall for one word is still a
 * waterfall.
 *
 * The day-scoped tabs are *not* prefetched, on purpose: their window is the viewer's
 * local midnight and the server does not have the viewer's clock. See the note in
 * `components/employee/employee-queries.ts`.
 *
 * Access is not decided here. `/people` is gated to managers and super admins in
 * `NAV`, the shell refuses any path `canAccessPath` rejects, and the API answers 403
 * to an employee asking for somebody else — RLS is the boundary underneath all three.
 *
 * The Suspense boundaries are for `useSearchParams`: the day lives in the query string,
 * so every piece of chrome that reads it is a client component that must be allowed to
 * resolve after the shell has painted.
 */
export default async function EmployeeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;

  return (
    <PrefetchBoundary queries={[employeeQuery(profileId), rosterQuery]}>
      <div className="mx-auto min-w-0 max-w-6xl">
        <Suspense fallback={<HeaderFallback />}>
          <EmployeeHeader profileId={profileId} />
        </Suspense>

        {/* Management actions — scope §4.2 — sited here rather than on one tab, because
            pausing somebody's collection is not a decision about the Overview tab. It
            renders nothing until the record it acts on has arrived, so it adds no third
            height to the settling sequence above it. */}
        <Suspense fallback={null}>
          <EmployeeActions profileId={profileId} />
        </Suspense>

        <Suspense fallback={<div className="h-11 border-b" />}>
          <EmployeeTabs profileId={profileId} />
        </Suspense>

        {/* 16px gutters on a phone, 24px from `sm` up. Six of the seven tabs put a
            table or a chart in here, and 48px of padding out of 375 is a column. */}
        <div className="px-4 py-6 sm:px-6">{children}</div>
      </div>
    </PrefetchBoundary>
  );
}

/**
 * The prerendered header, before any of its JavaScript has run.
 *
 * Reached only when the prefetch above found nothing — the API refused, or was down.
 * With a warm cache `EmployeeHeader` renders its real content synchronously and this
 * is never seen, which is the point of the boundary.
 *
 * Structurally identical to `EmployeeHeader`'s own loading branch — same padding,
 * same back link, same two bars in the same places — so the one case that still shows
 * it does not settle through two different heights.
 *
 * The back link is real rather than a grey bar: it works before the client bundle
 * arrives, which makes the one action available during the wait an actual action.
 */
function HeaderFallback() {
  return (
    <div className="px-4 py-6 sm:px-6">
      <Link
        href="/people"
        className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        People
      </Link>
      <div className="mt-4 flex items-center gap-4" aria-hidden>
        <span className="h-12 w-12 animate-pulse rounded-full bg-muted" />
        <div className="space-y-2">
          <span className="block h-5 w-44 animate-pulse rounded bg-muted" />
          <span className="block h-3.5 w-28 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}
