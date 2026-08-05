"use client";

import type { ReportDocument, ReportKind, ReportRow } from "@aems/analytics";
import {
  Badge,
  Button,
  CheckboxField,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TableSortButton,
  cn,
} from "@aems/ui";
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
import { Download, FileDown, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  SkeletonBar,
  TableSkeletonRows,
  queryViewState,
  type ViewState,
} from "@/components/states";
import { describeError, useApiQuery, useSession } from "@/lib/api";
import { dateKeyOf } from "@/lib/queries/activity";
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
  useRunReport,
  type ReportFormValues,
  type ReportHistoryRow,
  type ReportTypeDto,
} from "@/lib/queries/reports";

import { reportHistoryQuery, reportTypesQuery } from "./queries";

/**
 * Reports — one set of filters, two destinations.
 *
 * Cattr's split, adopted: "Run" renders the document to screen and "Export" writes the
 * same document to a file. Both call the same API with the same body, so the table a
 * manager reads and the CSV they send on cannot disagree.
 *
 * The catalogue is `GET /api/reports/types`, never a hardcoded list — that is also what
 * keeps an employee from being offered a manager-only report. It arrives already in the
 * cache: `page.tsx` prefetched it on the server, so the type selector is populated in
 * the first paint rather than after a round trip.
 *
 * The left-hand catalogue column this screen used to carry is gone. It was a 16rem
 * fixed column that stacked *above* the filters on a phone, so the densest form in the
 * product opened with a scroll past a list before any control was reachable. The type
 * is now the first control in the same row as the rest, which is also what makes the
 * whole form fit at 375px.
 */

const GROUPING_LABEL: Record<string, string> = {
  employee: "Employee",
  date: "Date",
  employee_date: "Employee and date",
  application: "Application",
  category: "Category",
  domain: "Website",
  event: "Every record",
};

export function ReportsView({
  initialKind,
  serverToday,
}: {
  /** `?kind=`, validated on the server. Null means "whatever the catalogue offers first". */
  initialKind: ReportKind | null;
  /** The rendering machine's calendar day — see `today.ts` and the effect below. */
  serverToday: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const session = useSession();
  const types = useApiQuery(reportTypesQuery);
  const history = useApiQuery(reportHistoryQuery);

  const run = useRunReport();
  const exportCsv = useExportCsv();
  const queue = useQueueReport();

  const catalogue = useMemo<ReportTypeDto[]>(() => types.data?.types ?? [], [types.data]);

  /**
   * "Today" starts as the server's day and is corrected to the reader's.
   *
   * Seeding straight from `new Date()` would evaluate on the server during SSR and
   * again in the browser during hydration; anyone whose calendar day differs from the
   * deploy region's gets two different values for the same input and React repairs the
   * mismatch by re-rendering the field. Seeding from a prop makes both renders agree,
   * and the effect below moves the fields only in the rare case where the two days
   * genuinely differ — and only while they are still untouched.
   */
  const [today, setToday] = useState(serverToday);

  const form = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues: {
      kind: initialKind ?? "time_and_activity",
      grouping: "employee",
      scope: "company",
      fromDate: serverToday,
      toDate: serverToday,
      decimalDuration: false,
    },
  });

  useEffect(() => {
    const browserToday = dateKeyOf(new Date());
    if (browserToday === serverToday) return;

    setToday(browserToday);
    if (form.getValues("fromDate") === serverToday) form.setValue("fromDate", browserToday);
    if (form.getValues("toDate") === serverToday) form.setValue("toDate", browserToday);
  }, [serverToday, form]);

  const kind = form.watch("kind");
  const grouping = form.watch("grouping");
  const scope = form.watch("scope");
  const decimalDuration = form.watch("decimalDuration");

  const activeType = catalogue.find((type) => type.id === kind) ?? catalogue[0];

  /*
   * The catalogue arrives after the form does — even prefetched, the form's defaults
   * are written before the first render reads the cache — so the chosen type and its
   * grouping are corrected once the real list is known. Sending an unsupported grouping
   * is not an error: the API silently swaps it, which would leave the control on screen
   * disagreeing with the header of the table it produced.
   */
  useEffect(() => {
    if (!activeType) return;
    if (activeType.id !== form.getValues("kind")) form.setValue("kind", activeType.id);

    const resolved = resolveGrouping(activeType, form.getValues("grouping"));
    if (resolved !== form.getValues("grouping")) form.setValue("grouping", resolved);
  }, [activeType, form]);

  function selectKind(nextId: string) {
    const next = catalogue.find((type) => type.id === nextId);
    if (!next) return;

    form.setValue("kind", next.id);
    form.setValue("grouping", next.defaultGrouping);
    // The type is the one filter worth carrying in a link — it is what a manager means
    // when they send "the website report". `replace`, so stepping through four types
    // does not leave four entries for the back button to walk out of.
    router.replace(`/reports?kind=${next.id}`, { scroll: false });
  }

  const scopes = useMemo(
    () => scopesForRole(session.data?.role ?? "employee"),
    [session.data?.role],
  );

  // Whichever action fired last owns the message area; showing three at once would make
  // a manager guess which one their click produced.
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
    await queryClient.invalidateQueries({ queryKey: reportHistoryQuery.queryKey });
  }

  const catalogueState = queryViewState(types, (data) => data.types.length === 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader
        title="Reports"
        subtitle="Run a report to read it here, or export the same numbers as a file."
      />

      <div className="min-w-0 space-y-5">
        {catalogueState === "error" ? (
          <ErrorState
            title="The report catalogue could not be loaded"
            message={describeError(types.error)}
            onRetry={() => void types.refetch()}
          />
        ) : catalogueState === "loading" ? (
          <FilterCardSkeleton />
        ) : catalogueState === "empty" ? (
          <EmptyState
            title="No report types are available to your role"
            body="Reports are offered per role. If you expect to see some here, ask your administrator."
          />
        ) : (
          <form
            onSubmit={form.handleSubmit((values) => void submit(values, "run"))}
            className="rounded-lg border bg-card p-4"
          >
            {/* Five controls, one row on a wide screen and one column on a phone. The
                two dates sit together at every width so a period never splits across
                a wrap. */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Field label="Report type" className="xl:col-span-1">
                {(field) => (
                  <Select value={activeType?.id ?? ""} onValueChange={selectKind}>
                    <SelectTrigger {...field} aria-label="Report type">
                      <SelectValue placeholder="Choose a report" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalogue.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <Field label="Group by" error={form.formState.errors.grouping?.message}>
                {(field) => (
                  <Select
                    value={grouping}
                    onValueChange={(value) => form.setValue("grouping", value)}
                  >
                    <SelectTrigger {...field} aria-label="Group by">
                      <SelectValue placeholder="Choose a grouping" />
                    </SelectTrigger>
                    <SelectContent>
                      {(activeType?.groupings ?? []).map((option) => (
                        <SelectItem key={option} value={option}>
                          {GROUPING_LABEL[option] ?? option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <Field
                label="Covering"
                error={form.formState.errors.scope?.message}
                {...(scopes.length === 1
                  ? { hint: "Your role reports on your own activity." }
                  : {})}
              >
                {(field) => (
                  <Select
                    value={scope}
                    disabled={scopes.length === 1}
                    onValueChange={(value) =>
                      form.setValue("scope", value as ReportFormValues["scope"])
                    }
                  >
                    <SelectTrigger {...field} aria-label="Covering">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scopes.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <Field label="From" error={form.formState.errors.fromDate?.message}>
                {(field) => (
                  <Input type="date" max={today} {...field} {...form.register("fromDate")} />
                )}
              </Field>

              <Field label="To" error={form.formState.errors.toDate?.message}>
                {(field) => (
                  <Input type="date" max={today} {...field} {...form.register("toDate")} />
                )}
              </Field>
            </div>

            {activeType ? (
              <p className="mt-3 text-sm text-muted-foreground">{activeType.description}</p>
            ) : null}

            <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <CheckboxField
                label="Decimal hours"
                description="7.50 instead of 7h 30m — the shape a spreadsheet wants."
                checked={decimalDuration}
                onCheckedChange={(next) => form.setValue("decimalDuration", next === true)}
              />

              {/* At 375px: Run across the full width, the two exports side by side
                  beneath it. Every one of them stays on screen and stays 36px tall. */}
              <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                <Button type="submit" disabled={run.isPending} className="col-span-2 sm:col-span-1">
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {run.isPending ? "Running" : "Run"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={exportCsv.isPending}
                  onClick={form.handleSubmit((values) => void submit(values, "csv"))}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  {exportCsv.isPending ? "Preparing" : "Export CSV"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={queue.isPending}
                  onClick={form.handleSubmit((values) => void submit(values, "pdf"))}
                >
                  <FileDown className="h-3.5 w-3.5" aria-hidden />
                  {queue.isPending ? "Queueing" : "Export PDF"}
                </Button>
              </div>
            </div>

            {failure ? (
              <div className="mt-3">
                <ErrorState title="That report could not be produced" message={describeError(failure)} />
              </div>
            ) : null}

            {queue.isSuccess ? (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                Queued. It appears in the export history below once the worker has written it.
              </p>
            ) : null}

            {exportCsv.isSuccess ? (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                Downloaded {exportCsv.data?.filename}.
              </p>
            ) : null}
          </form>
        )}

        {run.data ? <Result document={run.data} /> : <NotRunYet loading={run.isPending} />}

        <ExportHistory
          rows={history.data ?? []}
          state={queryViewState(history, (rows) => rows.length === 0)}
          error={history.isError ? describeError(history.error) : null}
          onRetry={() => void history.refetch()}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

function Result({ document }: { document: ReportDocument }) {
  const rows = document.sections[0]?.rows ?? [];
  const totals = document.sections[0]?.totals ?? null;

  return (
    <section aria-label="Report" className="min-w-0 space-y-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{document.title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {document.subtitle} · {document.rowCount} {document.rowCount === 1 ? "row" : "rows"}
        </p>
      </div>

      {document.notes.length > 0 || document.truncated ? (
        <ul className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          {document.truncated ? (
            <li>These numbers are a floor: the query hit its row ceiling before the period ended.</li>
          ) : null}
          {document.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing recorded in that period"
          body="Try a wider range, or check that an agent was reporting on those days."
        />
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
        // Sorts on the raw value — sorting formatted text would order "7h 30m" before
        // "45m" and read as a bug.
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
    // A report can carry nine columns, and it scrolls inside this container rather than
    // pushing the page sideways. `min-w-0` on the section above is what makes the
    // container obey its parent instead of being stretched by its own content.
    <Table containerClassName="rounded-lg border bg-card" className="min-w-[44rem]">
      <caption className="sr-only">{document.title}</caption>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => {
              const direction = header.column.getIsSorted();
              return (
                <TableHead
                  key={header.id}
                  scope="col"
                  sortDirection={direction === false ? null : direction}
                  className={cn(alignOf(header.column.id) === "right" && "text-right")}
                >
                  <TableSortButton
                    direction={direction === false ? null : direction}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableSortButton>
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
                  "py-2",
                  alignOf(cell.column.id) === "right" && "tabular text-right",
                )}
              >
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>

      {totals ? (
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            {resolved.map((column) => (
              <TableCell
                key={column.id}
                className={cn("py-2", column.align === "right" && "tabular text-right")}
              >
                {documentCell(totals, column)}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}

function NotRunYet({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <div className="rounded-lg border bg-card px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground" role="status">
          Building the report…
        </p>
      </div>
    );
  }

  return (
    <EmptyState
      title="No report on screen yet"
      body="Choose a type and a period, then press Run. Export writes the same numbers to a file."
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Export history                                                              */
/* -------------------------------------------------------------------------- */

const HISTORY_COLUMNS = [
  { key: "report", label: "Report", width: "w-32" },
  { key: "period", label: "Period", width: "w-28" },
  { key: "format", label: "Format", width: "w-12" },
  { key: "status", label: "Status", width: "w-20" },
  { key: "file", label: "File", align: "right" as const, width: "w-16" },
];

function ExportHistory({
  rows,
  state,
  error,
  onRetry,
}: {
  rows: ReportHistoryRow[];
  state: ViewState;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section aria-label="Export history" className="min-w-0 space-y-3">
      <h2 className="text-base font-semibold tracking-tight">Exports</h2>

      {state === "error" && error ? (
        <ErrorState title="The export history could not be loaded" message={error} onRetry={onRetry} />
      ) : (
        <Table containerClassName="rounded-lg border bg-card" className="min-w-[38rem]">
          <caption className="sr-only">Queued and finished report exports</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {HISTORY_COLUMNS.map((column) => (
                <TableHead
                  key={column.key}
                  scope="col"
                  className={cn(column.align === "right" && "text-right")}
                >
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {state === "loading" ? (
              <TableSkeletonRows columns={HISTORY_COLUMNS} rows={3} />
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={HISTORY_COLUMNS.length} className="px-4 py-10 text-center">
                  <p className="text-sm font-medium">No exports yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Files you queue appear here with their status and a download link.
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => <HistoryRow key={row.id} row={row} />)
            )}
          </TableBody>
        </Table>
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
    <TableRow>
      <TableCell className="font-medium capitalize">{row.kind.replace(/_/g, " ")}</TableCell>
      <TableCell className="tabular whitespace-nowrap text-muted-foreground">
        {row.period_start.slice(0, 10)} · {days} {days === 1 ? "day" : "days"}
      </TableCell>
      <TableCell className="uppercase text-muted-foreground">{row.format}</TableCell>
      <TableCell>
        <Badge variant={view.tone}>{view.label}</Badge>
        {view.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{view.detail}</p> : null}
        {failed ? <p className="mt-0.5 text-xs text-muted-foreground">{failed}</p> : null}
      </TableCell>
      <TableCell className="text-right">
        {view.downloadable ? (
          // `h-9` replaces the `sm` size's 32px: a download link in a dense table is
          // still a thing a thumb has to hit.
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => void download()}
            disabled={busy}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {busy ? "Opening" : "Download"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The filter card, before the catalogue lands.
 *
 * Reachable only when the server prefetch did not answer — the API refused or was
 * unreachable — because a warmed cache means `types` is never in a loading state. It is
 * the same box as the real card so the page does not jump when it is replaced.
 */
function FilterCardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading the report catalogue
      </span>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-hidden>
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index}>
            <SkeletonBar className="h-3 w-20" />
            <div className="mt-1.5 h-9 animate-pulse rounded-md border border-input bg-muted/50" />
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between" aria-hidden>
        <SkeletonBar className="h-4 w-48" />
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div className="col-span-2 h-9 w-full animate-pulse rounded-md bg-muted sm:w-20" />
          <div className="h-9 animate-pulse rounded-md border border-input bg-muted/50 sm:w-28" />
          <div className="h-9 animate-pulse rounded-md border border-input bg-muted/50 sm:w-28" />
        </div>
      </div>
    </div>
  );
}
