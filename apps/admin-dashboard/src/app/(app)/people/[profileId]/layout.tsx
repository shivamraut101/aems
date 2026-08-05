import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { EmployeeHeader } from "@/components/employee/employee-header";
import { EmployeeTabs } from "@/components/employee/employee-tabs";

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

      <div className="px-6 py-6">{children}</div>
    </div>
  );
}

/**
 * The prerendered header, before any of its JavaScript has run.
 *
 * Structurally identical to `EmployeeHeader`'s own loading branch — same padding,
 * same back link, same two bars in the same places — and that is the whole point.
 * This page is the most visited surface in the product and it used to settle through
 * three different heights: this fallback, then the header's skeleton, then the header
 * itself. Two of those were the same idea drawn at different sizes, so the page
 * jumped for no reason a reader could attribute to anything.
 *
 * The back link is real rather than a grey bar: it works before the client bundle
 * arrives, which makes the one action available during the wait an actual action.
 */
function HeaderFallback() {
  return (
    <div className="px-6 py-6">
      <Link
        href="/people"
        className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
