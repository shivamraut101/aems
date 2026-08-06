"use client";

import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortButton,
  cn,
} from "@aems/ui";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Download, Loader2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
} from "@/components/employee/states";
import { RelativeTime } from "@/components/relative-time";
import { queryViewState } from "@/components/states";
import { describeError, useSession } from "@/lib/api";
import {
  rangeLabel,
  reportBadgeVariant,
  reportKindLabel,
  usePersonReports,
  useReportDownload,
  type PersonReportRow,
} from "@/lib/queries/usage";

/** Shared by the header action and the empty state, so the two cannot drift apart. */
const runLinkClass =
  "inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Reports tab — scope §5, narrowed to one person.
 *
 * A whole-company run is deliberately absent even though it contains this person's
 * row: it is not their report, and listing it here would put every colleague's
 * numbers one click away from a page about one employee.
 *
 * `usePersonReports` caches the company's report list under `["reportHistory"]` and
 * narrows it per person with `select`, which is why the route's `page.tsx` prefetches
 * the unnarrowed list — one warmed entry serves every person's tab.
 */
export function ReportsTabView({ profileId }: { profileId: string }) {
  const query = usePersonReports(profileId);
  const { data: session } = useSession();
  const download = useReportDownload();

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const canRunReports = session?.role === "manager" || session?.role === "super_admin";
  const state = queryViewState(query, (value) => value.length === 0);

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
        cell: ({ row }) => <RelativeTime iso={row.original.created_at} />,
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row) => row.status,
        cell: ({ row }) => (
          <>
            {/* A dot, because this is a state the row is in rather than a label it
                carries — the same signal the device and presence pills use. */}
            <Badge variant={reportBadgeVariant(row.original.status)} dot>
              {row.original.status}
            </Badge>
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
            // `h-9` over the `sm` size's 32px: a download in a dense table is still a
            // thing a thumb has to hit.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              disabled={busy}
              onClick={() => download.mutate(report.id, { onSuccess: ({ url }) => openInNewTab(url) })}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {busy ? "Preparing" : "Download"}
            </Button>
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
            <Link href="/reports" className={runLinkClass}>
              Run a report
            </Link>
          ) : null
        }
      />

      <div className="space-y-3">
        {download.isError ? (
          <ErrorState title="That download could not be prepared" message={describeError(download.error)} />
        ) : null}

        {state === "error" ? (
          <ErrorState
            title="Reports could not be loaded"
            message={describeError(query.error)}
            onRetry={() => void query.refetch()}
          />
        ) : state === "loading" ? (
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
                  <Link href="/reports" className={runLinkClass}>
                    Run the first one
                  </Link>
                ) : null
              }
            />
          </Panel>
        ) : (
          <>
            <Lead rows={rows} />

            {/* Six columns; it scrolls inside its own container rather than pushing the
                page sideways. */}
            <Table containerClassName="rounded-lg border bg-card" className="min-w-[42rem]">
              <caption className="sr-only">Reports generated for this person</caption>

              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id} className="hover:bg-transparent">
                    {group.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const direction = sorted === false ? null : sorted;

                      return (
                        <TableHead
                          key={header.id}
                          scope="col"
                          // Undefined, not `null`, on the download column: `null` would
                          // announce `aria-sort="none"` on a column that cannot sort.
                          sortDirection={header.column.getCanSort() ? direction : undefined}
                        >
                          {header.column.getCanSort() ? (
                            <TableSortButton
                              direction={direction}
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                            </TableSortButton>
                          ) : (
                            <span className="sr-only">Download</span>
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>

              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          // Top, not middle: the Report and Status cells run to two
                          // lines, and a failure reason centred against a one-line
                          // neighbour reads as a different row.
                          "align-top",
                          cell.column.id === "rows" || cell.column.id === "created"
                            ? "tabular text-muted-foreground"
                            : cell.column.id === "period" && "text-muted-foreground",
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Whether anything here is waiting on the worker, before the table of rows.
 *
 * The question this tab gets opened with is "is my export ready yet?", and the answer
 * was previously only available by reading down a status column. A run that failed is
 * named in the same line, because a failure nobody notices is a report nobody re-runs.
 */
function Lead({ rows }: { rows: PersonReportRow[] }) {
  const pending = rows.filter((row) => row.status === "pending").length;
  const failed = rows.filter((row) => row.status === "failed").length;

  return (
    <p className="text-sm">
      <span className="tabular font-medium">{rows.length}</span>{" "}
      {rows.length === 1 ? "report" : "reports"} for this person
      {pending > 0 ? (
        <>
          {" · "}
          <span className="tabular">{pending}</span> still generating
        </>
      ) : null}
      {failed > 0 ? (
        <>
          {" · "}
          <span className="tabular text-destructive">{failed}</span> failed
        </>
      ) : null}
      {pending === 0 && failed === 0 ? " — all ready to download." : "."}
    </p>
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
