"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
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
import { useDayWindow } from "@/components/employee/use-day-window";
import { describeError } from "@/lib/api";
import { duration } from "@/lib/format";
import {
  cellOf,
  compareCells,
  renderCell,
  sectionOf,
  sharePercent,
  tableColumns,
  useAppUsage,
  type CellValue,
  type ReportRow,
  type UsageColumn,
} from "@/lib/queries/usage";

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

  const columns = useMemo(() => tableColumns(data), [data]);
  const rows = useMemo(() => sectionOf(data)?.rows ?? [], [data]);
  const totals = sectionOf(data)?.totals ?? null;
  const totalSeconds = Number(cellOf(totals, "duration") ?? 0);

  return (
    <div>
      <SectionHeading
        title="Applications"
        hint="Where the working time went, busiest first."
        action={
          rows.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              <span className="tabular font-medium text-foreground">{duration(totalSeconds)}</span> in{" "}
              {rows.length} {rows.length === 1 ? "application" : "applications"}
            </p>
          ) : null
        }
      />

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
              body="An application is recorded only while a work session is open on an enrolled device. Try another day, or check that the agent is running."
            />
          </Panel>
        ) : (
          <UsageTable columns={columns} rows={rows} totals={totals} caption="Application usage" />
        )}
      </div>
    </div>
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

/* ------------------------------------------------------------------------- */
/* Table                                                                      */
/* ------------------------------------------------------------------------- */

function UsageTable({
  columns,
  rows,
  totals,
  caption,
}: {
  columns: UsageColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  caption: string;
}) {
  const columnDefs = useMemo<ColumnDef<ReportRow>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.label,
        accessorFn: (row: ReportRow) => cellOf(row, column.id),
        sortingFn: (a, b, id) =>
          compareCells(a.getValue<CellValue>(id), b.getValue<CellValue>(id), column.numeric),
        cell: ({ row }) =>
          column.id === "share" ? (
            <ShareCell
              value={cellOf(row.original, column.id)}
              text={renderCell(row.original, column)}
            />
          ) : (
            renderCell(row.original, column)
          ),
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Panel className="overflow-hidden p-0">
      {/* Wide content scrolls inside its own container; the page body never does. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr
                key={group.id}
                className="border-b text-xs uppercase tracking-wide text-muted-foreground"
              >
                {group.headers.map((header) => {
                  const column = columns.find((candidate) => candidate.id === header.column.id);
                  const sorted = header.column.getIsSorted();

                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                      className={`px-4 py-2 font-medium ${
                        column?.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={`inline-flex items-center gap-1 rounded-sm uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          column?.align === "right" ? "flex-row-reverse" : ""
                        }`}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <SortIcon state={sorted} />
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b transition-colors last:border-0 hover:bg-secondary/40"
              >
                {row.getVisibleCells().map((cell) => {
                  const column = columns.find((candidate) => candidate.id === cell.column.id);

                  return (
                    <td
                      key={cell.id}
                      className={`px-4 py-2.5 ${
                        column?.align === "right" ? "tabular text-right" : "text-muted-foreground"
                      } ${column?.id === "application" ? "font-medium text-foreground" : ""}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className="border-t bg-secondary/40 font-medium">
                {columns.map((column, index) => (
                  <td
                    key={column.id}
                    className={`px-4 py-2.5 ${
                      column.align === "right" ? "tabular text-right" : "text-left"
                    }`}
                  >
                    {index === 0 ? "Total" : renderCell(totals, column)}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </Panel>
  );
}

/**
 * The share, as a number and as a length.
 *
 * Navy at low opacity rather than a status colour: a share is neither a success nor a
 * warning. Never indigo — `--accent` is reserved for AI surfaces. The bar is hidden
 * from assistive technology because the percentage beside it carries the same fact.
 */
function ShareCell({ value, text }: { value: CellValue; text: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-primary/40"
          style={{ width: `${sharePercent(value)}%` }}
        />
      </span>
      <span className="tabular w-10 text-right">{text}</span>
    </span>
  );
}

function SortIcon({ state }: { state: false | "asc" | "desc" }) {
  const className = "h-3 w-3 shrink-0";
  if (state === "asc") return <ArrowUp className={className} aria-hidden="true" />;
  if (state === "desc") return <ArrowDown className={className} aria-hidden="true" />;
  return <ChevronsUpDown className={`${className} opacity-40`} aria-hidden="true" />;
}
