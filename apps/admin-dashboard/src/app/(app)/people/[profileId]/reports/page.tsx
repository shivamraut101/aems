"use client";

import { Badge } from "@aems/ui";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";

import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
} from "@/components/employee/states";
import { describeError, useSession } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import {
  rangeLabel,
  reportBadgeVariant,
  reportKindLabel,
  usePersonReports,
  useReportDownload,
  type PersonReportRow,
} from "@/lib/queries/usage";

/**
 * Reports tab — scope §5, narrowed to one person.
 *
 * A whole-company run is deliberately absent even though it contains this person's
 * row: it is not their report, and listing it here would put every colleague's
 * numbers one click away from a page about one employee.
 */
export default function ReportsTabPage() {
  const params = useParams();
  const profileId = typeof params?.["profileId"] === "string" ? params["profileId"] : "";

  const { data, isPending, isError, error, refetch } = usePersonReports(profileId);
  const { data: session } = useSession();
  const download = useReportDownload();

  const rows = data ?? [];
  const canRunReports = session?.role === "manager" || session?.role === "super_admin";

  const columns = useMemo<ColumnDef<PersonReportRow>[]>(
    () => [
      {
        id: "kind",
        header: "Report",
        accessorFn: (row) => reportKindLabel(row.kind),
        cell: ({ row }) => (
          <>
            <span className="font-medium text-foreground">{reportKindLabel(row.original.kind)}</span>
            <p className="text-xs text-muted-foreground">
              by {row.original.grouping.replace(/_/g, " ")} · {row.original.format.toUpperCase()}
            </p>
          </>
        ),
      },
      {
        id: "period",
        header: "Period",
        accessorFn: (row) => row.period_start,
        cell: ({ row }) => rangeLabel(row.original.period_start, row.original.period_end),
      },
      {
        id: "rows",
        header: "Rows",
        // Never-counted sorts below zero rather than above every real count.
        accessorFn: (row) => row.row_count ?? -1,
        cell: ({ row }) => (row.original.row_count === null ? "—" : row.original.row_count),
      },
      {
        id: "created",
        header: "Requested",
        accessorFn: (row) => row.created_at,
        cell: ({ row }) => relativeTime(row.original.created_at),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row) => row.status,
        cell: ({ row }) => (
          <>
            <Badge variant={reportBadgeVariant(row.original.status)}>{row.original.status}</Badge>
            {/* A bare "failed" tells nobody what to do about it. */}
            {row.original.failure_reason ? (
              <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                {row.original.failure_reason}
              </p>
            ) : null}
          </>
        ),
      },
      {
        id: "download",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const report = row.original;
          const busy = download.isPending && download.variables === report.id;

          if (report.status !== "ready") {
            return (
              <span className="text-xs text-muted-foreground">
                {report.status === "pending" ? "Generating…" : "Unavailable"}
              </span>
            );
          }

          return (
            <button
              type="button"
              disabled={busy}
              onClick={() => download.mutate(report.id, { onSuccess: ({ url }) => openInNewTab(url) })}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {busy ? "Preparing" : "Download"}
            </button>
          );
        },
      },
    ],
    [download],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div>
      <SectionHeading
        title="Reports"
        hint="Exports generated for this person. Download links are signed and expire after five minutes."
        action={
          canRunReports ? (
            <Link
              href="/reports"
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Run a report
            </Link>
          ) : null
        }
      />

      <div className="space-y-3">
        {download.isError ? (
          <ErrorState title="That download could not be prepared" message={describeError(download.error)} />
        ) : null}

        {isError ? (
          <ErrorState
            title="Reports could not be loaded"
            message={describeError(error)}
            onRetry={() => void refetch()}
          />
        ) : isPending ? (
          <Panel>
            <span className="sr-only" aria-live="polite">
              Loading reports
            </span>
            <SkeletonLines count={4} />
          </Panel>
        ) : rows.length === 0 ? (
          <Panel>
            <EmptyState
              title="No reports for this person yet"
              body={
                canRunReports
                  ? "A report appears here once it names this person. Whole-company exports are not listed — they belong to the company, not to one employee."
                  : "Nothing has been exported about you yet."
              }
              action={
                canRunReports ? (
                  <Link
                    href="/reports"
                    className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Run the first one
                  </Link>
                ) : null
              }
            />
          </Panel>
        ) : (
          <Panel className="overflow-hidden p-0">
            {/* Wide content scrolls inside its own container; the page body never does. */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-sm">
                <caption className="sr-only">Reports generated for this person</caption>
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr
                      key={group.id}
                      className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {group.headers.map((header) => {
                        const sorted = header.column.getIsSorted();

                        return (
                          <th
                            key={header.id}
                            scope="col"
                            aria-sort={
                              sorted === "asc"
                                ? "ascending"
                                : sorted === "desc"
                                  ? "descending"
                                  : "none"
                            }
                            className="px-4 py-2 font-medium"
                          >
                            {header.column.getCanSort() ? (
                              <button
                                type="button"
                                onClick={header.column.getToggleSortingHandler()}
                                className="inline-flex items-center gap-1 rounded-sm uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                <SortIcon state={sorted} />
                              </button>
                            ) : (
                              <span className="sr-only">Download</span>
                            )}
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
                      className="border-b align-top transition-colors last:border-0 hover:bg-secondary/40"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={`px-4 py-2.5 ${
                            cell.column.id === "rows" || cell.column.id === "created"
                              ? "tabular text-muted-foreground"
                              : cell.column.id === "period"
                                ? "text-muted-foreground"
                                : ""
                          }`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * Opens a signed URL without handing the storage host a `window.opener` reference.
 *
 * A programmatic anchor rather than `window.open`: the URL is only known after an
 * await, and a popup blocker treats a late `window.open` as unsolicited.
 */
function openInNewTab(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

function SortIcon({ state }: { state: false | "asc" | "desc" }) {
  const className = "h-3 w-3 shrink-0";
  if (state === "asc") return <ArrowUp className={className} aria-hidden="true" />;
  if (state === "desc") return <ArrowDown className={className} aria-hidden="true" />;
  return <ChevronsUpDown className={`${className} opacity-40`} aria-hidden="true" />;
}
