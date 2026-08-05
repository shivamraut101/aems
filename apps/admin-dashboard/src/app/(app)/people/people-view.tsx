"use client";

import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { Plus, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { PageHeader } from "@/components/page-header";
import { ErrorState, FilterBarSkeleton, StaleNotice, queryViewState } from "@/components/states";
import { describeError, useApiQuery, useSession, type EmployeeRow } from "@/lib/api";
import { isDeactivated } from "@/lib/queries/employees-form";
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
import { roleLabel } from "@/lib/session";
import { mergeQuery, useColumnVisibility, useFilters } from "@/store/filters";

import { AddPersonDialog } from "./add-person-dialog";
import {
  PEOPLE_COLUMNS,
  PEOPLE_COLUMN_CLASS,
  PEOPLE_COLUMN_LABEL,
  PEOPLE_TABLE_MIN_WIDTH,
  peopleColumnWidthNote,
} from "./columns";
import { rosterQuery } from "./queries";

/**
 * The roster, `docs/scope.md` §4.2 — client half.
 *
 * The data is already in the cache when this first renders: `page.tsx` warmed the same
 * spec on the server. So there is no first-load skeleton here in the ordinary case, and
 * `queryViewState` — not a hand-rolled ternary, and never `isFetching` — decides what to
 * draw when the ordinary case does not hold.
 *
 * Filters live in the query string, so "Support, monitoring paused" is a link a manager
 * can send rather than a state only they can see. There is deliberately **no range
 * control**: `/api/employees` takes no window, and a picker that changed nothing on the
 * page it sits on is worse than no picker.
 */
export function PeopleView() {
  return (
    // `useSearchParams` needs a boundary or `next build` refuses to prerender the
    // route. The fallback is drawn full-size — a short grey box where a table belongs
    // is a layout shift with a pulse on it, not a loading state.
    <Suspense fallback={<PeopleFallback />}>
      <PeopleScreen />
    </Suspense>
  );
}

const columnHelper = createColumnHelper<EmployeeRow>();

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
   * the URL like every other filter here — the server page reads the same parameter to
   * decide which of the two roster entries to warm.
   *
   * Without it a deactivated person is unreachable: the only screen that can bring them
   * back is their own, and the roster is the only route to it.
   */
  const showDeactivated = searchParams.get("deactivated") === "1";

  const roster = useApiQuery(rosterQuery(showDeactivated));
  const rows = useMemo(() => roster.data ?? [], [roster.data]);
  const state = queryViewState(roster);

  // Not a security boundary — `PATCH /api/employees/:id` is `requireSuperAdmin` and the
  // create route is its sibling, so a manager who saw this button would meet a 403 at
  // the end of a filled-in form. The API is what enforces it.
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
            <p className="truncate text-xs text-muted-foreground">
              {context.row.original.email}
            </p>
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
        cell: (context) => (
          <span className="tabular text-muted-foreground">{context.getValue()}</span>
        ),
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
          compareLastSeen(
            a.getValue<string | null>("lastSeen"),
            b.getValue<string | null>("lastSeen"),
          ),
        cell: (context) => (
          <RelativeTime iso={context.getValue()} className="tabular text-muted-foreground" />
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
  const visibleColumns = table.getVisibleFlatColumns();

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader
        title="People"
        subtitle="Everyone in your company, with the devices assigned to them."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Add person
            </Button>
          ) : null
        }
      />

      {addOpen ? <AddPersonDialog onClose={() => setAddOpen(false)} /> : null}

      <FilterBar
        filters={filters}
        departments={departments}
        onChange={setFilters}
        table={table}
        disabled={state === "loading" || state === "error"}
        showDeactivated={showDeactivated}
        onShowDeactivatedChange={setShowDeactivated}
      />

      {state === "error" ? (
        // The shared surface, with a retry. The bare paragraph this replaces stated a
        // failure and offered no way out of it except reloading the browser tab, and
        // carried no `role="alert"`, so a screen reader was never told at all.
        <ErrorState
          title="The roster could not be loaded"
          message={describeError(roster.error)}
          onRetry={() => void roster.refetch()}
        />
      ) : (
        <>
          {state === "stale" ? (
            <StaleNotice
              className="mb-2 rounded-md border"
              message="This roster could not be refreshed, so it may be a few minutes old."
              onRetry={() => void roster.refetch()}
            />
          ) : null}

          {state !== "loading" && rows.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Showing <span className="tabular">{filtered.length}</span> of{" "}
              <span className="tabular">{rows.length}</span>
            </p>
          ) : null}

          {/* The table scrolls inside its own box; the page body never scrolls
              sideways. The minimum width steps down with the column set — see
              `columns.ts`. */}
          <Table
            containerClassName="rounded-lg border bg-card"
            className={PEOPLE_TABLE_MIN_WIDTH.className}
          >
            <caption className="sr-only">
              Employees, sortable by name, department, role, device count, monitoring
              state and last activity
            </caption>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const right = header.column.id === "lastSeen";

                    return (
                      <TableHead
                        key={header.id}
                        scope="col"
                        sortDirection={sorted === false ? null : sorted}
                        className={cn(
                          PEOPLE_COLUMN_CLASS[header.column.id],
                          right && "text-right",
                        )}
                      >
                        <TableSortButton
                          direction={sorted === false ? null : sorted}
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
              {state === "loading" ? (
                <LoadingRows columnIds={visibleColumns.map((column) => column.id)} />
              ) : filtered.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={visibleColumns.length} className="px-4 py-12 text-center">
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
                      <Button type="button" onClick={() => setAddOpen(true)} className="mt-4">
                        <Plus className="h-4 w-4" aria-hidden />
                        Add person
                      </Button>
                    ) : null}
                    {filtersActive && rows.length > 0 ? (
                      <Button
                        type="button"
                        variant="link"
                        className="mt-3"
                        onClick={() =>
                          setFilters({ search: "", department: null, monitoring: "all" })
                        }
                      >
                        Clear filters
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "align-top",
                          PEOPLE_COLUMN_CLASS[cell.column.id],
                          cell.column.id === "lastSeen" && "text-right",
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Radix refuses an empty string as a `SelectItem` value, so "everything" needs a name. */
const ANY_DEPARTMENT = "__all__";

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
  return (
    // Stacked on a phone, one row from `sm` up. The old version was `flex-wrap` with a
    // fixed `w-72` search field, which at 375px is wider than the page it sits on.
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <SearchField filters={filters} onChange={onChange} />

      <Select
        value={filters.department ?? ANY_DEPARTMENT}
        onValueChange={(value) =>
          onChange({ ...filters, department: value === ANY_DEPARTMENT ? null : value })
        }
        disabled={disabled || departments.length === 0}
      >
        <SelectTrigger aria-label="Filter by department" className="w-full sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_DEPARTMENT}>All departments</SelectItem>
          {departments.map((department) => (
            <SelectItem key={department} value={department}>
              {department === UNASSIGNED_DEPARTMENT ? "No department" : department}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.monitoring}
        onValueChange={(value) =>
          onChange({ ...filters, monitoring: value as PeopleFilters["monitoring"] })
        }
      >
        <SelectTrigger aria-label="Filter by monitoring state" className="w-full sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any monitoring state</SelectItem>
          <SelectItem value="on">Monitoring on</SelectItem>
          <SelectItem value="paused">Monitoring paused</SelectItem>
        </SelectContent>
      </Select>

      {/* Not part of `PeopleFilters`: this one changes the *request*, not which of the
          rows already fetched are shown, so it belongs beside them rather than in them.
          It is still in the query string, so "the people who have left" stays a link
          somebody can send. */}
      <label className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm sm:w-auto">
        <Checkbox
          checked={showDeactivated}
          onCheckedChange={(value) => onShowDeactivatedChange(value === true)}
        />
        Include deactivated
      </label>

      <ColumnsMenu table={table} />
    </div>
  );
}

/**
 * The search box, with the URL written a beat after the typing rather than on it.
 *
 * The field is controlled locally and the query string is updated 250ms later. This
 * route is dynamically rendered — the root layout reads the request's cookies — so
 * every `router.replace` is an RSC round trip to the server, and a replace per
 * keystroke turns "sarah" into five of them. The URL is still the source of truth: the
 * effect below follows it whenever it changes from outside this field, which is what
 * makes Back, a shared link and the "Clear filters" button all still work.
 */
function SearchField({
  filters,
  onChange,
}: {
  filters: PeopleFilters;
  onChange: (next: PeopleFilters) => void;
}) {
  const committed = filters.search;
  const [draft, setDraft] = useState(committed);

  // Held in a ref so the debounce below depends on the text alone. `onChange` and
  // `filters` are new objects on every render of the parent, and depending on them
  // would restart the timer on each one — which is a debounce that never fires.
  const commit = useRef(onChange);
  const current = useRef(filters);
  commit.current = onChange;
  current.current = filters;

  useEffect(() => {
    setDraft(committed);
  }, [committed]);

  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      commit.current({ ...current.current, search: draft });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, committed]);

  return (
    <SearchInput
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder="Search name, email or department"
      aria-label="Search people"
      containerClassName="w-full sm:w-72"
    />
  );
}

/**
 * Column visibility.
 *
 * Was a `<details>` element, which cannot be positioned: an absolutely positioned panel
 * hanging off a summary runs straight off the viewport when the control sits near an
 * edge, and at 375px that control is always near an edge. Radix portals it, flips it to
 * the other side when it would collide, and caps its height at the space available.
 *
 * The width note beside a name is not decoration. Some columns are drawn only above a
 * viewport width (see `columns.ts`), and without it the menu lies by omission — a
 * reader ticks "Devices" on a 1024px screen, sees nothing appear, and concludes the
 * control is broken.
 */
function ColumnsMenu({ table }: { table: ReturnType<typeof useReactTable<EmployeeRow>> }) {
  return (
    <div className="w-full sm:ml-auto sm:w-auto">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full sm:w-auto">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" aria-hidden />
            Columns
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          {table.getAllLeafColumns().map((column) => {
            const note = peopleColumnWidthNote(column.id);

            return (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={column.getIsVisible()}
                onCheckedChange={(value) => column.toggleVisibility(value === true)}
                // Keeps the menu open so several columns can be toggled in one visit.
                onSelect={(event) => event.preventDefault()}
              >
                <span className="flex w-full items-center gap-3">
                  <span className="min-w-0 truncate">
                    {PEOPLE_COLUMN_LABEL[column.id] ?? column.id}
                  </span>
                  {note ? (
                    <span className="ml-auto shrink-0 text-[10px] tabular text-muted-foreground">
                      {note}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Placeholder rows shaped to the columns currently on screen.
 *
 * Written here rather than taken from `TableSkeletonRows` because those cells cannot
 * carry the responsive classes, and a placeholder standing in a column the viewport
 * hides is a row of the wrong width.
 *
 * Rarely seen at all: the roster is prefetched on the server, so this is what a cold
 * cache after a failed prefetch looks like, not what a normal load looks like.
 */
function LoadingRows({ columnIds, rows = 6 }: { columnIds: readonly string[]; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <TableRow key={rowIndex} className="hover:bg-transparent" aria-hidden>
          {columnIds.map((id) => (
            <TableCell
              key={id}
              className={cn(
                "align-top",
                PEOPLE_COLUMN_CLASS[id],
                id === "lastSeen" && "text-right",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3.5 animate-pulse rounded bg-muted align-middle",
                  id === "name" ? "w-32" : "w-20",
                )}
              />
              {id === "name" ? (
                <span className="mt-1.5 block h-2.5 w-24 animate-pulse rounded bg-muted/60" />
              ) : null}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/**
 * The Suspense fallback, which is a whole table rather than a grey box.
 *
 * A bordered empty card is pixel-identical to a company with nobody in it, so the
 * screen used to say "you have no employees" for as long as the roster took to arrive.
 * The filter row is drawn for the same reason — four controls appearing from nowhere is
 * a 44px shove of everything below them.
 */
function PeopleFallback() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader
        title="People"
        subtitle="Everyone in your company, with the devices assigned to them."
      />
      <span className="sr-only" role="status">
        Loading the roster
      </span>
      <FilterBarSkeleton fields={3} />
      <Table
        containerClassName="rounded-lg border bg-card"
        className={PEOPLE_TABLE_MIN_WIDTH.className}
      >
        <caption className="sr-only">Employees, loading</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {PEOPLE_COLUMNS.map((column) => (
              <TableHead
                key={column.id}
                scope="col"
                className={cn(column.className, column.align === "right" && "text-right")}
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <LoadingRows columnIds={PEOPLE_COLUMNS.map((column) => column.id)} />
        </TableBody>
      </Table>
    </div>
  );
}
