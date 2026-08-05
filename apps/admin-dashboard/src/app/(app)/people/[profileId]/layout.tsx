import { Suspense } from "react";

import { EmployeeHeader } from "@/components/employee/employee-header";
import { EmployeeTabs } from "@/components/employee/employee-tabs";

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

      <Suspense fallback={<div className="h-11 border-b" />}>
        <EmployeeTabs profileId={profileId} />
      </Suspense>

      <div className="px-6 py-6">{children}</div>
    </div>
  );
}

function HeaderFallback() {
  return (
    <div className="flex items-center gap-4 px-6 pb-4 pt-11" aria-hidden>
      <span className="h-12 w-12 animate-pulse rounded-full bg-muted" />
      <div className="space-y-2">
        <span className="block h-5 w-44 animate-pulse rounded bg-muted" />
        <span className="block h-3.5 w-28 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
