"use client";

import type { ReportDocument, ReportRow } from "@aems/analytics";
import { Badge, cn } from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Download, FileDown, Play } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { PageHeader } from "@/components/page-header";
import { describeError, useSession } from "@/lib/api";
import {
  documentCell,
  documentColumns,
  fetchReportDownloadUrl,
  historyView,
  reportFormSchema,
  resolveGrouping,
  scopesForRole,
  toReportSpec,
  useExportCsv,
  useQueueReport,
  useReportHistory,
  useReportTypes,
  useRunReport,
  type ReportFormValues,
  type ReportHistoryRow,
  type ReportTypeDto,
} from "@/lib/queries/reports";
import { dateKeyOf } from "@/lib/queries/activity";

/**
 * Reports — one set of filters, two destinations.
 *
 * Cattr's split, adopted: "Run" renders the document to screen and "Export" writes
 * the same document to a file. Both call the same API with the same body, so the
 * table a manager reads and the CSV they send on cannot disagree.
 *
 * The catalogue on the left is `GET /api/reports/types`, never a hardcoded list —
 * that is also what keeps an employee from being offered a manager-only report.
 */
export default function ReportsPage() {
  return (
    <Suspense fallback={<ReportsSkeleton />}>
      <ReportsScreen />
    </Suspense>
  );
}

const GROUPING_LABEL: Record<string, string> = {
  employee: "Employee",
  date: "Date",
  employee_date: "Employee and date",
  application: "Application",
  category: "Category",
  domain: "Website",
  event: "Every record",
};

function ReportsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();

  const session = useSession();
  const types = useReportTypes();
  const history = useReportHistory();

  const run = useRunReport();
  const exportCsv = useExportCsv();
  const queue = useQueueReport();

  const today = dateKeyOf(new Date());
  const form = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues: {
      kind: (params.get("kind") as ReportFormValues["kind"]) ?? "time_and_activity",
      grouping: "employee",
      scope: "company",
      fromDate: today,
      toDate: today,
      decimalDuration: false,
    },
  });

  const kind = form.watch("kind");
  const activeType = types.data?.find((type) => type.id === kind) ?? types.data?.[0];

  // The catalogue arrives after the form does, so the grouping is corrected once it
  // is known to be one the chosen type actually supports. Sending an unsupported one
  // is not an error — the API silently swaps it, which would leave the control on
  // screen disagreeing with the header of the table it produced.
  useEffect(() => {
    if (!activeType) return;
    if (activeType.id !== form.getValues("kind")) form.setValue("kind", activeType.id);

    const grouping = resolveGrouping(activeType, form.getValues("grouping"));
    if (grouping !== form.getValues("grouping")) form.setValue("grouping", grouping);
  }, [activeType, form]);

  function selectKind(next: ReportTypeDto) {
    form.setValue("kind", next.id);
    form.setValue("grouping", next.defaultGrouping);
    const query = new URLSearchParams(params.toString());
    query.set("kind", next.id);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  const scopes = useMemo(() => scopesForRole(session.data?.role ?? "employee"), [session.data?.role]);

  // Whichever action fired last owns the message area; showing three at once would
  // make a manager guess which one their click produced.
  const failure = run.error ?? exportCsv.error ?? queue.error ?? null;

  async function submit(values: ReportFormValues, action: "run" | "csv" | "pdf") {
    const spec = toReportSpec(values);

    if (action === "run") {
      exportCsv.reset();
      queue.reset();
      run.mutate(spec);
      return;
    }

    if (action === "csv") {
      run.reset();
      queue.reset();
      exportCsv.mutate(spec);
      return;
    }

    run.reset();
    exportCsv.reset();
    await queue.mutateAsync({ ...spec, format: "pdf" });
    await queryClient.invalidateQueries({ queryKey: ["reportHistory"] });
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-7">
      <PageHeader
        title="Reports"
        subtitle="Run a report to read it here, or export the same numbers as a file."
      />

      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Catalogue
          types={types.data ?? []}
          selectedId={activeType?.id ?? null}
          loading={types.isLoading}
          error={types.isError ? describeError(types.error) : null}
          onSelect={selectKind}
        />

        <div className="min-w-0 space-y-5">
          {session.isLoading ? (
            <div className="h-40 animate-pulse rounded-lg border bg-card" />
          ) : (
            <form
              onSubmit={form.handleSubmit((values) => void submit(values, "run"))}
              className="rounded-lg border bg-card p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Group by" error={form.formState.errors.grouping?.message}>
                  <select {...form.register("grouping")} className={fieldClass}>
                    {(activeType?.groupings ?? []).map((grouping) => (
                      <option key={grouping} value={grouping}>
                        {GROUPING_LABEL[grouping] ?? grouping}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Covering" error={form.formState.errors.scope?.message}>
                  <select {...form.register("scope")} className={fieldClass} disabled={scopes.length === 1}>
                    {scopes.map((scope) => (
                      <option key={scope.value} value={scope.value}>
                        {scope.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="From" error={form.formState.errors.fromDate?.message}>
                  <input type="date" max={today} {...form.register("fromDate")} className={fieldClass} />
                </Field>

                <Field label="To" error={form.formState.errors.toDate?.message}>
                  <input type="date" max={today} {...form.register("toDate")} className={fieldClass} />
                </Field>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    {...form.register("decimalDuration")}
                    className="h-4 w-4 rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  Decimal hours (7.50 instead of 7h 30m)
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={run.isPending} className={primaryButton}>
                    <Play className="h-3.5 w-3.5" aria-hidden />
                    {run.isPending ? "Running" : "Run"}
                  </button>
                  <button
                    type="button"
                    disabled={exportCsv.isPending}
                    onClick={form.handleSubmit((values) => void submit(values, "csv"))}
                    className={secondaryButton}
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                    {exportCsv.isPending ? "Preparing" : "Export CSV"}
                  </button>
                  <button
                    type="button"
                    disabled={queue.isPending}
                    onClick={form.handleSubmit((values) => void submit(values, "pdf"))}
                    className={secondaryButton}
                  >
                    <FileDown className="h-3.5 w-3.5" aria-hidden />
                    {queue.isPending ? "Queueing" : "Export PDF"}
                  </button>
                </div>
              </div>

              {activeType ? (
                <p className="mt-3 text-xs text-muted-foreground">{activeType.description}</p>
              ) : null}

              {failure ? (
                <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                  {describeError(failure)}
                </p>
              ) : null}

              {queue.isSuccess ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Queued. It appears in the export history below once the worker has written it.
                </p>
              ) : null}

              {exportCsv.isSuccess ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Downloaded {exportCsv.data?.filename}.
                </p>
              ) : null}
            </form>
          )}

          {run.data ? <Result document={run.data} /> : <NotRunYet loading={run.isPending} />}

          <ExportHistory
            rows={history.data ?? []}
            loading={history.isLoading}
            error={history.isError ? describeError(history.error) : null}
          />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

function Catalogue({
  types,
  selectedId,
  loading,
  error,
  onSelect,
}: {
  types: ReportTypeDto[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (type: ReportTypeDto) => void;
}) {
  return (
    <nav aria-label="Report types" className="overflow-hidden rounded-lg border bg-card">
      <h2 className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Report type
      </h2>

      {error ? (
        <p className="px-3 py-6 text-sm text-muted-foreground">{error}</p>
      ) : loading ? (
        <ul className="divide-y">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="px-3 py-3">
              <span className="block h-4 w-28 animate-pulse rounded bg-muted" />
            </li>
          ))}
        </ul>
      ) : types.length === 0 ? (
        <p className="px-3 py-6 text-sm text-muted-foreground">
          No report types are available to your role.
        </p>
      ) : (
        <ul className="divide-y">
          {types.map((type) => {
            const active = type.id === selectedId;
            return (
              <li key={type.id}>
                <button
                  type="button"
                  onClick={() => onSelect(type)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "w-full px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                >
                  <span className="block text-sm font-medium">{type.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{type.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

function Result({ document }: { document: ReportDocument }) {
  const rows = document.sections[0]?.rows ?? [];
  const totals = document.sections[0]?.totals ?? null;

  return (
    <section aria-label="Report" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{document.title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {document.subtitle} · {document.rowCount} {document.rowCount === 1 ? "row" : "rows"}
          </p>
        </div>
      </div>

      {document.notes.length > 0 || document.truncated ? (
        <ul className="space-y-1 rounded-md border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/5 px-3 py-2 text-xs">
          {document.truncated ? (
            <li>These numbers are a floor: the query hit its row ceiling before the period ended.</li>
          ) : null}
          {document.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card px-4 py-10 text-center">
          <p className="text-sm font-medium">Nothing recorded in that period</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a wider range, or check that an agent was reporting on those days.
          </p>
        </div>
      ) : (
        <DocumentTable document={document} rows={rows} totals={totals} />
      )}
    </section>
  );
}

function DocumentTable({
  document,
  rows,
  totals,
}: {
  document: ReportDocument;
  rows: ReportRow[];
  totals: ReportRow | null;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const resolved = useMemo(() => documentColumns(document), [document]);

  const columns = useMemo<ColumnDef<ReportRow>[]>(
    () =>
      resolved.map((column) => ({
        id: column.id,
        header: column.label,
        // Sorts on the raw value — sorting formatted text would order "7h 30m"
        // before "45m" and read as a bug.
        accessorFn: (row: ReportRow) => row.cells[column.id] ?? null,
        cell: (info) => documentCell(info.row.original, column),
      })),
    [resolved],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const alignOf = (id: string): "left" | "right" =>
    resolved.find((column) => column.id === id)?.align ?? "left";

  return (
    // Wide reports scroll inside their own container; the page body never moves.
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[42rem] text-sm">
        <caption className="sr-only">{document.title}</caption>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              {group.headers.map((header) => {
                const direction = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    className={cn("px-4 py-2 font-medium", alignOf(header.column.id) === "right" && "text-right")}
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {direction === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : null}
                      {direction === "desc" ? <ArrowDown className="h-3 w-3" aria-hidden /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>

        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b transition-colors last:border-0 hover:bg-secondary/40">
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className={cn(
                    "px-4 py-2",
                    alignOf(cell.column.id) === "right" && "tabular text-right",
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>

        {totals ? (
          <tfoot>
            <tr className="border-t bg-secondary/40 font-medium">
              {resolved.map((column) => (
                <td
                  key={column.id}
                  className={cn("px-4 py-2", column.align === "right" && "tabular text-right")}
                >
                  {documentCell(totals, column)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function NotRunYet({ loading }: { loading: boolean }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-10 text-center">
      {loading ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Building the report…
        </p>
      ) : (
        <>
          <p className="text-sm font-medium">No report on screen yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a type and a period, then press Run. Export writes the same numbers to a file.
          </p>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Export history                                                              */
/* -------------------------------------------------------------------------- */

function ExportHistory({
  rows,
  loading,
  error,
}: {
  rows: ReportHistoryRow[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <section aria-label="Export history" className="space-y-3">
      <h2 className="text-base font-semibold tracking-tight">Exports</h2>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">{error}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">Queued and finished report exports</caption>
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Report</th>
                <th scope="col" className="px-4 py-2 font-medium">Period</th>
                <th scope="col" className="px-4 py-2 font-medium">Format</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">File</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [0, 1, 2].map((i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td colSpan={5} className="px-4 py-2.5">
                      <span className="block h-4 w-full animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium">No exports yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Files you queue appear here with their status and a download link.
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((row) => <HistoryRow key={row.id} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HistoryRow({ row }: { row: ReportHistoryRow }) {
  const view = historyView(row);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    setFailed(null);
    try {
      const { url } = await fetchReportDownloadUrl(row.id);
      window.open(url, "_blank", "noopener");
    } catch (error) {
      setFailed(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const days = Math.round((Date.parse(row.period_end) - Date.parse(row.period_start)) / 86_400_000);

  return (
    <tr className="border-b transition-colors last:border-0 hover:bg-secondary/40">
      <td className="px-4 py-2.5 font-medium">{row.kind.replace(/_/g, " ")}</td>
      <td className="tabular px-4 py-2.5 text-muted-foreground">
        {row.period_start.slice(0, 10)} · {days} {days === 1 ? "day" : "days"}
      </td>
      <td className="px-4 py-2.5 uppercase text-muted-foreground">{row.format}</td>
      <td className="px-4 py-2.5">
        <Badge variant={view.tone}>{view.label}</Badge>
        {view.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{view.detail}</p> : null}
        {failed ? <p className="mt-0.5 text-xs text-muted-foreground">{failed}</p> : null}
      </td>
      <td className="px-4 py-2.5 text-right">
        {view.downloadable ? (
          <button
            type="button"
            onClick={() => void download()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {busy ? "Opening" : "Download"}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

const fieldClass =
  "h-9 w-full rounded-md border bg-card px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const primaryButton =
  "inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const secondaryButton =
  "inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-destructive">{error}</span> : null}
    </label>
  );
}

function ReportsSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-7">
      <div className="mb-6 h-7 w-32 animate-pulse rounded bg-muted" />
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="h-64 animate-pulse rounded-lg border bg-card" />
        <div className="h-64 animate-pulse rounded-lg border bg-card" />
      </div>
    </div>
  );
}
