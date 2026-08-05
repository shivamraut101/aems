"use client";

import { Badge, cn } from "@aems/ui";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, useState } from "react";

import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  FilterBarSkeleton,
  TableSkeleton,
  TableSkeletonRows,
  type SkeletonColumn,
} from "@/components/states";
import { describeError, useSession, type EmployeeRow } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import {
  UNASSIGNED_DEPARTMENT,
  compareLastSeen,
  departmentOptions,
  matchesPeopleFilter,
  parsePeopleFilters,
  peopleFilterParams,
  peopleLastSeen,
  type PeopleFilters,
} from "@/lib/queries/roster-view";
import { isDeactivated } from "@/lib/queries/employees-form";
import { useRoster } from "@/lib/queries/employees";
import { roleLabel } from "@/lib/session";
import { mergeQuery, useColumnVisibility, useFilters } from "@/store/filters";

import { AddPersonDialog } from "./add-person-dialog";
import { primaryButtonClass } from "./dialog";

/**
 * The roster, `docs/scope.md` §4.2.
 *
 * Two things changed here from the hand-rolled version. The filters live in the
 * query string, so "Support, monitoring paused" is a link a manager can send rather
 * than a state only they can see. And the table is TanStack Table, so sorting and
 * column visibility exist at all — the previous implementation offered a substring
 * scan and nothing else, which is fine at twenty people and useless at five hundred.
 *
 * There is deliberately **no range control on this screen**. `/api/employees` takes
 * no window, and a picker that changed nothing on the page it sits on is worse than
 * no picker at all.
 */
export default function PeoplePage() {
  return (
    // useSearchParams needs a boundary; without one the whole route opts out of
    // static rendering and `next build` says so.
    <Suspense fallback={<PeopleSkeleton />}>
      <PeopleScreen />
    </Suspense>
  );
}

const columnHelper = createColumnHelper<EmployeeRow>();

/**
 * Column order, labels and placeholder shapes, in one place.
 *
 * Both skeletons on this screen are built from this, which is the point. A bordered
 * empty box is pixel-identical to a roster with nobody in it, and that box ships
 * inside the prerendered HTML — so the first thing a manager saw on a cold load was
 * indistinguishable from "this company has no employees". And `lines: 2` on the name
 * column is not decoration: a real name cell is a link over an email address, so a
 * one-line placeholder makes every loading row 20px short and the header columns snap
 * sideways the moment data lands.
 */
const PEOPLE_COLUMNS: readonly SkeletonColumn[] = [
  { key: "name", label: "Name", lines: 2, width: "w-32" },
  { key: "department", label: "Department", width: "w-24" },
  { key: "role", label: "Role", width: "w-20" },
  { key: "devices", label: "Devices", width: "w-6" },
  { key: "monitoring", label: "Monitoring", width: "w-14" },
  { key: "lastSeen", label: "Last seen", align: "right", width: "w-24" },
];

const COLUMN_LABELS: Record<string, string> = Object.fromEntries(
  PEOPLE_COLUMNS.map((column) => [column.key, column.label] as const),
);

function PeopleScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  const columnVisibility = useColumnVisibility("people");
  const setColumnVisibility = useFilters((state) => state.setColumnVisibility);

  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [addOpen, setAddOpen] = useState(false);

  /**
   * Off-boarded people are hidden by the API unless asked for, and the state lives in
   * the URL like every other filter on this page.
   *
   * Without it a deactivated person is unreachable: the only screen that can bring
   * them back is their own, and the roster is the only route to it.
   */
  const showDeactivated = searchParams.get("deactivated") === "1";

  const { data, isLoading, isError, error, refetch } = useRoster(showDeactivated);
  const rows = useMemo(() => data ?? [], [data]);

  // Not a security boundary — `PATCH /api/employees/:id` is `requireSuperAdmin` and
  // the create route is its sibling, so a manager who saw this button would meet a
  // 403 at the end of a filled-in form. The API is what enforces it.
  const { data: session } = useSession();
  const canManage = session?.role === "super_admin";

  const filters = useMemo(
    () =>
      parsePeopleFilters({
        q: searchParams.get("q"),
        dept: searchParams.get("dept"),
        monitoring: searchParams.get("monitoring"),
      }),
    [searchParams],
  );

  /**
   * Written per keystroke, and that is affordable: this route prerenders statically,
   * so a query-string change is resolved in the browser without a server round trip.
   * `replace` rather than `push` keeps twenty half-typed searches out of history.
   */
  function setFilters(next: PeopleFilters) {
    const query = mergeQuery(search, peopleFilterParams(next));
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function setShowDeactivated(next: boolean) {
    const query = mergeQuery(search, { deactivated: next ? "1" : null });
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const departments = useMemo(() => departmentOptions(rows), [rows]);
  const filtered = useMemo(
    () => rows.filter((person) => matchesPeopleFilter(person, filters)),
    [rows, filters],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.full_name || row.email, {
        id: "name",
        header: "Name",
        cell: (context) => (
          <>
            <Link
              href={`/people/${context.row.original.id}`}
              className="rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {context.getValue()}
            </Link>
            <p className="text-xs text-muted-foreground">{context.row.original.email}</p>
          </>
        ),
      }),
      columnHelper.accessor((row) => row.department ?? UNASSIGNED_DEPARTMENT, {
        id: "department",
        header: "Department",
        cell: (context) => <span className="text-muted-foreground">{context.getValue()}</span>,
      }),
      columnHelper.accessor("role", {
        id: "role",
        header: "Role",
        cell: (context) => (
          <span className="text-muted-foreground">{roleLabel(context.getValue())}</span>
        ),
      }),
      columnHelper.accessor((row) => row.devices.length, {
        id: "devices",
        header: "Devices",
        cell: (context) => <span className="tabular text-muted-foreground">{context.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.monitoring_enabled, {
        id: "monitoring",
        header: "Monitoring",
        // A deactivated person is always paused, so "Paused" would be true and
        // uninformative — it reads as a choice somebody made this morning rather than
        // as an account that has been off-boarded.
        cell: (context) =>
          isDeactivated(context.row.original) ? (
            <Badge variant="revoked">Deactivated</Badge>
          ) : (
            <Badge variant={context.getValue() ? "online" : "offline"}>
              {context.getValue() ? "On" : "Paused"}
            </Badge>
          ),
      }),
      columnHelper.accessor((row) => peopleLastSeen(row), {
        id: "lastSeen",
        header: "Last seen",
        // Instants, not strings — see compareLastSeen. Never-seen sorts as oldest.
        sortingFn: (a, b) =>
          compareLastSeen(a.getValue<string | null>("lastSeen"), b.getValue<string | null>("lastSeen")),
        cell: (context) => (
          <span className="tabular text-muted-foreground">{relativeTime(context.getValue())}</span>
        ),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) => {
      const next: VisibilityState =
        typeof updater === "function" ? updater(columnVisibility) : updater;
      setColumnVisibility("people", next);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const filtersActive =
    filters.search !== "" || filters.department !== null || filters.monitoring !== "all";

  const visibleSkeletonColumns = useMemo(() => {
    const visible = new Set(table.getVisibleFlatColumns().map((column) => column.id));
    return PEOPLE_COLUMNS.filter((column) => visible.has(column.key));
  }, [table, columnVisibility]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader
        title="People"
        subtitle="Everyone in your company, with the devices assigned to them."
        actions={
          canManage ? (
            <button type="button" onClick={() => setAddOpen(true)} className={primaryButtonClass}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add person
            </button>
          ) : null
        }
      />

      {addOpen ? <AddPersonDialog onClose={() => setAddOpen(false)} /> : null}

      <FilterBar
        filters={filters}
        departments={departments}
        onChange={setFilters}
        table={table}
        disabled={isLoading || isError}
        showDeactivated={showDeactivated}
        onShowDeactivatedChange={setShowDeactivated}
      />

      {isError ? (
        // The shared surface, with a retry. The bare paragraph this replaces stated a
        // failure and offered no way out of it except reloading the whole browser tab,
        // and carried no `role="alert"`, so a screen reader was never told at all.
        <ErrorState
          title="The roster could not be loaded"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          {!isLoading && rows.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Showing <span className="tabular">{filtered.length}</span> of{" "}
              <span className="tabular">{rows.length}</span>
            </p>
          ) : null}

          {/* The table scrolls inside its own box; the page body never scrolls sideways. */}
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">
                Employees, sortable by name, department, role, device count, monitoring state
                and last activity
              </caption>
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr
                    key={group.id}
                    className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    {group.headers.map((header) => (
                      <SortableHeader
                        key={header.id}
                        header={header}
                        align={header.column.id === "lastSeen" ? "right" : "left"}
                      />
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {isLoading ? (
                  // Shaped to the columns actually on screen, so hiding one does not
                  // leave a placeholder standing where its cell no longer is.
                  <TableSkeletonRows columns={visibleSkeletonColumns} rows={6} />
                ) : filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={table.getVisibleFlatColumns().length}
                      className="px-4 py-12 text-center"
                    >
                      <p className="text-sm font-medium">
                        {rows.length === 0 ? "No employees yet" : "No one matches these filters"}
                      </p>
                      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                        {rows.length > 0
                          ? "Try a different name, department or monitoring state."
                          : canManage
                            ? "Add the first person and their account is created from here. Nothing is collected until they sign in on a device and accept the monitoring policy."
                            : "Nobody has been added to this company yet. A super admin can add people from this screen; they appear here as soon as the account exists, before any device enrols."}
                      </p>
                      {rows.length === 0 && canManage ? (
                        <button
                          type="button"
                          onClick={() => setAddOpen(true)}
                          className={cn(primaryButtonClass, "mt-4")}
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden />
                          Add person
                        </button>
                      ) : null}
                      {filtersActive && rows.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setFilters({ search: "", department: null, monitoring: "all" })
                          }
                          className="mt-3 rounded text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Clear filters
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b transition-colors last:border-0 hover:bg-secondary/40"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={cn(
                            "px-4 py-2.5 align-top",
                            cell.column.id === "lastSeen" && "text-right",
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function FilterBar({
  filters,
  departments,
  onChange,
  table,
  disabled,
  showDeactivated,
  onShowDeactivatedChange,
}: {
  filters: PeopleFilters;
  departments: string[];
  onChange: (next: PeopleFilters) => void;
  table: ReturnType<typeof useReactTable<EmployeeRow>>;
  disabled: boolean;
  showDeactivated: boolean;
  onShowDeactivatedChange: (next: boolean) => void;
}) {
  const searchId = useId();
  const departmentId = useId();
  const monitoringId = useId();
  const deactivatedId = useId();

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          id={searchId}
          type="search"
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          placeholder="Search name, email or department"
          aria-label="Search people"
          className="h-9 w-72 rounded-md border border-input bg-card pl-8 pr-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </div>

      <div>
        <label htmlFor={departmentId} className="sr-only">
          Department
        </label>
        <select
          id={departmentId}
          value={filters.department ?? ""}
          onChange={(event) =>
            onChange({ ...filters, department: event.target.value || null })
          }
          disabled={disabled || departments.length === 0}
          className={selectClass}
        >
          <option value="">All departments</option>
          {departments.map((department) => (
            <option key={department} value={department}>
              {department === UNASSIGNED_DEPARTMENT ? "No department" : department}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor={monitoringId} className="sr-only">
          Monitoring
        </label>
        <select
          id={monitoringId}
          value={filters.monitoring}
          onChange={(event) =>
            onChange({ ...filters, monitoring: event.target.value as PeopleFilters["monitoring"] })
          }
          className={selectClass}
        >
          <option value="all">Any monitoring state</option>
          <option value="on">Monitoring on</option>
          <option value="paused">Monitoring paused</option>
        </select>
      </div>

      {/* Not part of `PeopleFilters`: this one changes the *request*, not which of the
          rows already fetched are shown, so it belongs beside them rather than in
          them. It is still in the query string, so "the people who have left" stays a
          link somebody can send. */}
      <label
        htmlFor={deactivatedId}
        className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm"
      >
        <input
          id={deactivatedId}
          type="checkbox"
          checked={showDeactivated}
          onChange={(event) => onShowDeactivatedChange(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        Include deactivated
      </label>

      <ColumnsMenu table={table} />
    </div>
  );
}

const selectClass =
  "h-9 rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Column visibility.
 *
 * A native `<details>` rather than a custom popover: it is open/closed state the
 * browser already implements with correct keyboard behaviour, and this is the one
 * genuinely client-only preference on the page — which is why it, and not the
 * filters, is what Zustand holds.
 */
function ColumnsMenu({ table }: { table: ReturnType<typeof useReactTable<EmployeeRow>> }) {
  return (
    <details className="relative ml-auto">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        Columns
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border bg-popover p-1.5 shadow-lg">
        {table.getAllLeafColumns().map((column) => (
          <label
            key={column.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/60"
          >
            <input
              type="checkbox"
              checked={column.getIsVisible()}
              onChange={column.getToggleVisibilityHandler()}
              className="h-3.5 w-3.5 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {COLUMN_LABELS[column.id] ?? column.id}
          </label>
        ))}
      </div>
    </details>
  );
}

type HeaderContext = ReturnType<
  ReturnType<typeof useReactTable<EmployeeRow>>["getHeaderGroups"]
>[number]["headers"][number];

function SortableHeader({ header, align }: { header: HeaderContext; align: "left" | "right" }) {
  const sorted = header.column.getIsSorted();

  return (
    <th
      scope="col"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
      className={cn("px-4 py-2 font-medium", align === "right" && "text-right")}
    >
      <button
        type="button"
        onClick={header.column.getToggleSortingHandler()}
        className={cn(
          "inline-flex items-center gap-1 rounded uppercase tracking-wide transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {flexRender(header.column.columnDef.header, header.getContext())}
        {sorted === "asc" ? (
          <ArrowUp className="h-3 w-3" aria-hidden />
        ) : sorted === "desc" ? (
          <ArrowDown className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
}

/**
 * The prerendered fallback — what the browser paints before any JavaScript runs.
 *
 * It has to be a *table*, headers and all. This markup ships inside the static HTML
 * for `/people`, and the bordered empty card it replaces was pixel-identical to a
 * company with nobody in it: the screen said "you have no employees" for as long as
 * the roster took to arrive, which on a cold connection is the first thing a new
 * customer ever sees. The filter row is drawn for the same reason — three controls
 * appearing from nowhere is a 44px shove of everything below them.
 */
function PeopleSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader
        title="People"
        subtitle="Everyone in your company, with the devices assigned to them."
      />
      <FilterBarSkeleton fields={4} />
      <TableSkeleton
        columns={PEOPLE_COLUMNS}
        rows={6}
        caption="Employees, loading"
        minWidthClass="min-w-[44rem]"
      />
    </div>
  );
}
