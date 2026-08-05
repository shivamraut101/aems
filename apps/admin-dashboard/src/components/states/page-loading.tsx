import {
  FilterBarSkeleton,
  SkeletonBar,
  type SkeletonColumn,
  StatGridSkeleton,
  TableSkeleton,
} from "./skeletons";

/**
 * The frame every loading state in the app renders.
 *
 * The shape matters more than the shimmer. Each skeleton below mirrors the page it
 * stands in for — same container width, same header block, same column headers, same
 * row count — because the point is that nothing moves when the content lands. A
 * generic grey box fixes the dead click and then makes the page jump once it resolves,
 * which trades one complaint for another.
 */
export function PageLoading({
  action = false,
  children,
}: {
  action?: boolean;
  children?: React.ReactNode;
}) {
  return (
    // Matches the container every page body uses. A different max-width here would
    // shift the whole layout sideways the moment the real page arrived.
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-7" aria-busy="true">
      {/*
        One live region for the page rather than a label on each bar. A screen reader
        should hear "Loading" once, not once per skeleton.
      */}
      <span className="sr-only" role="status">
        Loading
      </span>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <SkeletonBar className="h-7 w-48 max-w-full" />
          <SkeletonBar className="h-4 w-64 max-w-full" />
        </div>
        {action ? <SkeletonBar className="h-9 w-32 shrink-0 rounded-md" /> : null}
      </header>

      {children}
    </div>
  );
}

/**
 * Filters over a table.
 *
 * Columns are passed through rather than counted, because `TableSkeleton` renders the
 * real header labels. That is the difference between a placeholder and a stand-in: the
 * header is already correct while the rows are still loading, so when data lands only
 * the rows change and the table does not re-flow under the reader's eye.
 */
export function TablePageLoading({
  columns,
  caption,
  rows = 6,
  filters = 3,
  action = true,
}: {
  columns: readonly SkeletonColumn[];
  caption: string;
  rows?: number;
  filters?: number;
  action?: boolean;
}) {
  return (
    <PageLoading action={action}>
      <FilterBarSkeleton fields={filters} />
      <div className="mt-4">
        <TableSkeleton columns={columns} rows={rows} caption={caption} />
      </div>
    </PageLoading>
  );
}

/** Figures over panels: Overview, Insights, the employee tabs. */
export function DashboardPageLoading({ cells = 5 }: { cells?: number }) {
  return (
    <PageLoading>
      <StatGridSkeleton cells={cells} />
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <SkeletonBar className="h-64 rounded-lg" />
        <SkeletonBar className="h-64 rounded-lg" />
      </div>
    </PageLoading>
  );
}

/* -------------------------------------------------------------------------- */
/* One shape per route                                                         */
/* -------------------------------------------------------------------------- */

const PEOPLE_COLUMNS = [
  { key: "name", label: "Name", lines: 2, width: "w-40" },
  { key: "department", label: "Department", width: "w-28" },
  { key: "role", label: "Role", width: "w-24" },
  { key: "devices", label: "Devices", align: "right", width: "w-8" },
  { key: "monitoring", label: "Monitoring", width: "w-12" },
  { key: "lastSeen", label: "Last seen", align: "right", width: "w-24" },
] as const satisfies readonly SkeletonColumn[];

const DEVICE_COLUMNS = [
  { key: "device", label: "Device", lines: 2, width: "w-44" },
  { key: "person", label: "Assigned to", width: "w-32" },
  { key: "os", label: "OS", width: "w-28" },
  { key: "status", label: "Status", width: "w-16" },
  { key: "lastSeen", label: "Last seen", align: "right", width: "w-24" },
] as const satisfies readonly SkeletonColumn[];

const ACTIVITY_COLUMNS = [
  { key: "person", label: "Employee", lines: 2, width: "w-40" },
  { key: "status", label: "Status", width: "w-20" },
  { key: "app", label: "Application", width: "w-36" },
  { key: "lastSeen", label: "Last seen", align: "right", width: "w-24" },
] as const satisfies readonly SkeletonColumn[];

const REPORT_COLUMNS = [
  { key: "type", label: "Report", lines: 2, width: "w-44" },
  { key: "subject", label: "Subject", width: "w-32" },
  { key: "period", label: "Period", width: "w-32" },
  { key: "created", label: "Created", align: "right", width: "w-24" },
] as const satisfies readonly SkeletonColumn[];

/**
 * The skeleton for a path, chosen without rendering that route.
 *
 * Defined as data rather than left to each `loading.tsx`, because the same shape is
 * needed in two places that cannot share a render: Next's own Suspense fallback, and
 * the app shell, which paints this the instant a navigation starts rather than waiting
 * for Next to have the destination ready. Keeping one table of shapes is what stops
 * those two from drifting into showing different skeletons for the same page.
 *
 * Longest prefix wins, so `/people/<id>` gets the employee shape rather than the
 * roster's. Anything unrecognised falls back to the dashboard shape, which is the
 * commonest layout and is never wrong enough to be jarring.
 */
export function RouteSkeleton({ path }: { path: string }) {
  if (path === "/people") {
    return <TablePageLoading columns={PEOPLE_COLUMNS} caption="Loading the people in your company" />;
  }
  if (path === "/devices" || path.endsWith("/devices")) {
    return <TablePageLoading columns={DEVICE_COLUMNS} caption="Loading enrolled devices" />;
  }
  if (path === "/activity") {
    return <TablePageLoading columns={ACTIVITY_COLUMNS} caption="Loading recent activity" />;
  }
  if (path === "/reports" || path.endsWith("/reports")) {
    return <TablePageLoading columns={REPORT_COLUMNS} caption="Loading reports" filters={2} />;
  }
  if (path.startsWith("/settings")) return <DashboardPageLoading cells={3} />;
  if (path.startsWith("/insights")) return <DashboardPageLoading cells={3} />;
  if (path.startsWith("/account")) return <DashboardPageLoading cells={3} />;
  if (path.startsWith("/my-devices")) return <DashboardPageLoading cells={3} />;
  if (path.startsWith("/me")) return <DashboardPageLoading cells={4} />;
  return <DashboardPageLoading cells={5} />;
}
