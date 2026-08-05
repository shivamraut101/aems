"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Info } from "lucide-react";
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
import { devicesQuery } from "@/components/employee/employee-queries";
import { describeError, useApiQuery } from "@/lib/api";
import { duration } from "@/lib/format";
import {
  cellOf,
  compareCells,
  devicesForProfile,
  renderCell,
  sectionOf,
  sharePercent,
  tableColumns,
  useWebsiteUsage,
  websiteCoverage,
  type CellValue,
  type CoverageLevel,
  type ReportRow,
  type UsageColumn,
} from "@/lib/queries/usage";

/**
 * Websites tab — scope §2.5.
 *
 * The one screen whose completeness depends on which OS the person works on. The
 * agent reads a real address from the browser on macOS; on Windows there is no
 * supported way to read a tab's address from outside the browser, so it records only
 * a domain the window title spells out and refuses to guess. That gap is stated on
 * the page rather than left to be discovered as a bug — a short list here is a
 * platform limit, not an absence of work.
 */
export function WebsitesTabView({ profileId }: { profileId: string }) {
  return (
    <Suspense fallback={<LoadingPanel />}>
      <WebsitesTab profileId={profileId} />
    </Suspense>
  );
}

function WebsitesTab({ profileId }: { profileId: string }) {
  const day = useDayWindow();
  const range = useMemo(() => ({ from: day?.from ?? "", to: day?.to ?? "" }), [day?.from, day?.to]);

  const { data, isPending, isError, error, refetch } = useWebsiteUsage(profileId, range);
  // Prefetched by this route's `page.tsx`, so the coverage note is in the first
  // paint rather than appearing under the table a beat later.
  const devices = useApiQuery(devicesQuery);

  const coverage = useMemo(
    () =>
      websiteCoverage(
        devicesForProfile(devices.data ?? [], profileId).map((device) => device.platform),
      ),
    [devices.data, profileId],
  );

  const columns = useMemo(() => tableColumns(data), [data]);
  const rows = useMemo(() => sectionOf(data)?.rows ?? [], [data]);
  const totals = sectionOf(data)?.totals ?? null;
  const totalSeconds = Number(cellOf(totals, "duration") ?? 0);
  const visits = Number(cellOf(totals, "visits") ?? 0);

  return (
    <div>
      <SectionHeading
        title="Websites"
        hint="Domains visited in the browser, busiest first."
        action={
          rows.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              <span className="tabular font-medium text-foreground">{duration(totalSeconds)}</span>{" "}
              across {rows.length} {rows.length === 1 ? "domain" : "domains"} ·{" "}
              <span className="tabular">{visits}</span> {visits === 1 ? "visit" : "visits"}
            </p>
          ) : null
        }
      />

      <div className="space-y-3">
        {/* Shown whether or not there are rows: reading a short list and reading an
            empty one both depend on knowing what this person's fleet can see. */}
        {devices.isPending ? null : <CoveragePanel level={coverage.level} note={coverage.note} />}

        {data?.truncated ? <TruncationNotice /> : null}
        {(data?.notes ?? []).map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}

        {isError ? (
          <ErrorState
            title="Website usage could not be loaded"
            message={describeError(error)}
            onRetry={() => void refetch()}
          />
        ) : !day || isPending ? (
          <LoadingPanel />
        ) : rows.length === 0 ? (
          <Panel>
            <EmptyState
              title="No website activity recorded on this day"
              body={
                coverage.level === "window-title" || coverage.level === "mixed"
                  ? "On Windows this is expected unless a page title spelled out its address. Application usage for the same day is on the Apps tab."
                  : "Browser time is captured only while a work session is open on an enrolled device. Try another day."
              }
            />
          </Panel>
        ) : (
          <UsageTable columns={columns} rows={rows} totals={totals} caption="Website usage" />
        )}
      </div>
    </div>
  );
}

/**
 * What this person's devices can actually see.
 *
 * Amber for the two platform-limited readings, because those explain missing rows.
 * Muted for the rest, which are statements of fact rather than caveats. The text
 * never blames the employee or the product — it names the platform.
 */
function CoveragePanel({ level, note }: { level: CoverageLevel; note: string }) {
  const limited = level === "window-title" || level === "mixed";

  return (
    <div
      className={`flex gap-2.5 rounded-md px-3 py-2 text-xs ${
        limited
          ? "border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10"
          : "border bg-card text-muted-foreground"
      }`}
    >
      <Info className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{note}</span>
    </div>
  );
}

function LoadingPanel() {
  return (
    <Panel>
      <span className="sr-only" aria-live="polite">
        Loading website usage
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
                      } ${column?.id === "domain" ? "font-medium text-foreground" : ""}`}
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

/** Navy at low opacity — a share is neither a success nor a warning, and never indigo. */
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
