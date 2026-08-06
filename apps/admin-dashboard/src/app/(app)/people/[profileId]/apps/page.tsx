"use client";

import { useParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
  TruncationNotice,
} from "@/components/employee/states";
import { UsageTable, busiestRow } from "@/components/employee/usage-table";
import { useDayWindow } from "@/components/employee/use-day-window";
import { describeError } from "@/lib/api";
import { duration } from "@/lib/format";
import { cellOf, sectionOf, tableColumns, useAppUsage, type ReportRow } from "@/lib/queries/usage";

/**
 * Applications tab — scope §2.4.
 *
 * Reads `/api/reports/run` rather than a dashboard-only aggregate so this table and
 * the exported CSV are the same numbers. That endpoint merges each application's
 * spans *within* one person before summing, which is what stops a laptop and a phone
 * reporting the same hour from counting twice.
 *
 * `useSearchParams` (inside `useDayWindow`) forces a Suspense boundary during
 * prerender, so the tab itself is a child component.
 *
 * **The only tab with nothing to prefetch, and deliberately so.** Its one read is
 * `POST /api/reports/run` over a window that starts at the *viewer's* local midnight,
 * which the server render does not have — see rule 2 in `lib/server-query.tsx`. A
 * server prefetch would warm a key the browser never asks for and the page would pay
 * for the same report twice. The skeleton below stays, and it is honest: the question
 * does not exist until the browser's clock is readable. Splitting this into a server
 * shell with an empty `queries={[]}` would be ceremony, not a fix.
 */
export default function AppsTabPage() {
  return (
    <Suspense fallback={<LoadingPanel />}>
      <AppsTab />
    </Suspense>
  );
}

function AppsTab() {
  const params = useParams();
  const profileId = typeof params?.["profileId"] === "string" ? params["profileId"] : "";

  // The day lives in the URL and is resolved after mount, shared with every other tab
  // on this page so all seven agree about which day they are showing.
  const day = useDayWindow();
  const range = useMemo(() => ({ from: day?.from ?? "", to: day?.to ?? "" }), [day?.from, day?.to]);

  const { data, isPending, isError, error, refetch } = useAppUsage(profileId, range);

  // `tableColumns` resolves each column's format against the document's decimal-hours
  // flag; the raw section columns have not had that applied.
  const columns = useMemo(() => tableColumns(data), [data]);
  const rows = useMemo(() => sectionOf(data)?.rows ?? [], [data]);
  const totals = sectionOf(data)?.totals ?? null;
  const totalSeconds = Number(cellOf(totals, "duration") ?? 0);

  return (
    <div>
      <SectionHeading title="Applications" hint="Where the working time went, busiest first." />

      <div className="space-y-3">
        {data?.truncated ? <TruncationNotice /> : null}
        {(data?.notes ?? []).map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}

        {isError ? (
          <ErrorState
            title="Application usage could not be loaded"
            message={describeError(error)}
            onRetry={() => void refetch()}
          />
        ) : !day || isPending ? (
          <LoadingPanel />
        ) : rows.length === 0 ? (
          <Panel>
            <EmptyState
              title="No application activity on this day"
              body="An application is recorded only while a work session is open on an enrolled device. Use the day picker above to check another day, or check that the agent is running on this person's machine."
            />
          </Panel>
        ) : (
          <>
            <Lead rows={rows} totalSeconds={totalSeconds} />
            <UsageTable columns={columns} rows={rows} totals={totals} caption="Application usage" />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What the day was spent on, in a sentence, above the table that proves it.
 *
 * The figures used to sit right-aligned beside the heading as "6h 12m in 9
 * applications" — a measurement a reader had to turn into a conclusion themselves.
 * The one thing somebody opens this tab to learn is where the time actually went, so
 * the busiest application is named here rather than left to be found by reading down
 * a column. Both figures survive; only their framing changed.
 */
function Lead({ rows, totalSeconds }: { rows: ReportRow[]; totalSeconds: number }) {
  const busiest = busiestRow(rows);
  const name = String(cellOf(busiest, "application") ?? "").trim();
  const busiestSeconds = Number(cellOf(busiest, "duration") ?? 0);
  const count = rows.length;

  return (
    <p className="text-sm">
      <span className="tabular font-medium">{duration(totalSeconds)}</span> across{" "}
      <span className="tabular">{count}</span> {count === 1 ? "application" : "applications"}
      {name && busiestSeconds > 0 ? (
        <>
          {" — mostly "}
          <span className="font-medium" title={name}>
            {name}
          </span>{" "}
          at <span className="tabular">{duration(busiestSeconds)}</span>.
        </>
      ) : (
        "."
      )}
    </p>
  );
}

function LoadingPanel() {
  return (
    <Panel>
      <span className="sr-only" aria-live="polite">
        Loading application usage
      </span>
      <SkeletonLines count={6} />
    </Panel>
  );
}
