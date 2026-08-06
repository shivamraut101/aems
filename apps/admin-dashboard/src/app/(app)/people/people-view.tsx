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
import {
  EmptyState,
  ErrorState,
  FilterBarSkeleton,
  StaleNotice,
  queryViewState,
} from "@/components/states";
import { describeError, useApiQuery, useSession, type EmployeeRow } from "@/lib/api";
import { isDeactivated } from "@/lib/queries/employees-form";
import {
  EMPTY_PEOPLE_FILTERS,
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

/** What the page is, for as long as it cannot say anything more useful than that. */
const ROSTER_SUBTITLE = "Everyone in your company, with the devices assigned to them.";

interface RosterHealth {
  /** Off-boarded accounts excluded — they are history, not headcount. */
  people: number;
  withoutDevice: number;
  paused: number;
}

/**
 * The roster's own "is this okay?" question, answered before the table.
 *
 * A list of names is not a conclusion. The thing a super admin actually opens this page
 * to find out is whether the rollout is complete — and the honest gap is people whose
 * account exists but whose agent never got installed, because for them the product is
 * doing nothing at all while the roster reads as if it were.
 *
 * Deactivated people are skipped throughout: including them would make "12 people" mean
 * something different depending on whether the Include-deactivated box happened to be
 * ticked, and a headline number that moves with a filter is not a headline number.
 */
function rosterHealth(rows: readonly EmployeeRow[]): RosterHealth {
  let people = 0;
  let withoutDevice = 0;
  let paused = 0;

  for (const row of rows) {
    if (isDeactivated(row)) continue;
    people += 1;
    if (row.devices.length === 0) withoutDevice += 1;
    if (!row.monitoring_enabled) paused += 1;
  }

  return { people, withoutDevice, paused };
}

function rosterSentence({ people, withoutDevice, paused }: RosterHealth): string {
  const clauses: string[] = [];

  if (withoutDevice > 0) {
    clauses.push(
      `${withoutDevice} ${withoutDevice === 1 ? "has" : "have"} no device enrolled, so nothing is being collected for them yet`,
    );
  }
  if (paused > 0) {
    clauses.push(`${paused} ${paused === 1 ? "has" : "have"} monitoring paused`);
  }

  if (clauses.length === 0) {
    return `All ${people} ${people === 1 ? "person has" : "people have"} a device enrolled and monitoring on.`;
  }

  return `${people} ${people === 1 ? "person" : "people"}. Of those, ${clauses.join(", and ")}.`;
}

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

  /**
   * Undo every narrowing in one go, including the deactivated toggle.
   *
   * One control rather than two, because a reader looking at an unexpectedly short list
   * does not care which of the four parameters shortened it — and leaving "Include
   * deactivated" behind after a "Clear" is exactly the sort of residue that makes
   * somebody reload the page to be sure.
   */
  function clearFilters() {
    const query = mergeQuery(search, {
      ...peopleFilterParams(EMPTY_PEOPLE_FILTERS),
      deactivated: null,
    });
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const departments = useMemo(() => departmentOptions(rows), [rows]);
  const filtered = useMemo(
    () => rows.filter((person) => matchesPeopleFilter(person, filters)),
    [rows, filters],
  );
  const health = useMemo(() => rosterHealth(rows), [rows]);

  /**
   * What is currently narrowing the list, in words.
   *
   * "Showing 4 of 12" says a filter is on; it does not say *which*, and the control
   * holding it may be scrolled off a phone screen or — in the case of the search box —
   * hold text the reader typed several minutes ago. Naming them is the difference
   * between a short list and a short list somebody can explain.
   */
  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (filters.search) labels.push(`“${filters.search}”`);
    if (filters.department !== null) {
      labels.push(
        filters.department === UNASSIGNED_DEPARTMENT ? "no department" : filters.department,
      );
    }
    if (filters.monitoring !== "all") {
      labels.push(filters.monitoring === "on" ? "monitoring on" : "monitoring paused");
    }
    if (showDeactivated) labels.push("including deactivated");
    return labels;
  }, [filters, showDeactivated]);

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.full_name || row.email, {
        id: "name",
        header: "Name",
        cell: (context) => {
          const person = context.row.original;
          const name = context.getValue();

          return (
            /*
             * The whole primary cell is the door, not the few characters of the name.
             * A roster row exists to be opened, and a 38px cell offers a thumb far more
             * to aim at than a text run does. The negative margins push the hit area
             * back out over the cell's own padding, which a plain block link would
             * otherwise leave dead.
             *
             * Both lines truncate with the full value on `title`: a long name and a
             * long address are the two strings on this page capable of widening the
             * table past the phone it is read on.
             */
            <Link
              href={`/people/${person.id}`}
              className="group -mx-2 -my-1 block rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "block truncate font-medium group-hover:underline",
                  // The subtle half of the off-boarded marker. The Monitoring column
                  // says what happened; dimming says this row is not a live one, which
                  // is the part a reader needs while scanning rather than reading.
                  isDeactivated(person) && "text-muted-foreground",
                )}
                title={name}
              >
                {name}
              </span>
              <span className="block truncate text-xs text-muted-foreground" title={person.email}>
                {person.email}
              </span>
            </Link>
          );
        },
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
        /*
         * Only the states worth stopping on get a badge.
         *
         * Monitoring is on for very nearly everybody, so a pill in every row drew a
         * wall of identical green down a column that was, in practice, constant — and a
         * badge that never varies is decoration competing with the two rows that do.
         * The ordinary case is plain text; the exceptions keep the pill and the dot,
         * which is what the dot is for.
         *
         * The column keeps its width because it keeps its job: it still sorts, still
         * toggles, and still reads as a value rather than a blank to a screen reader.
         * What it answers is the *setting* — whether collection is permitted. Whether
         * anything is actually arriving is the Last seen column's question, and the two
         * compose: "On" beside "No device" is the whole story in one row.
         *
         * A deactivated person is always paused, so "Paused" would be true and
         * uninformative — it reads as a choice somebody made this morning rather than
         * as an account that has been off-boarded.
         */
        cell: (context) =>
          isDeactivated(context.row.original) ? (
            <Badge variant="revoked" dot>Deactivated</Badge>
          ) : context.getValue() ? (
            <span className="text-muted-foreground">On</span>
          ) : (
            <Badge variant="offline" dot>Paused</Badge>
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
        cell: (context) => {
          /*
           * "Never" is a statement about a device that has not checked in. Somebody
           * with no device has never been asked to, and rendering both as "never" made
           * a company that simply has not rolled the agent out yet look like a fleet of
           * dead agents — the two need completely different actions from a reader, so
           * they must not be the same word.
           *
           * Both still sort as the oldest possible instant, which is what they are; the
           * comparator above is untouched.
           */
          if (context.row.original.devices.length === 0) {
            return <span className="text-muted-foreground">No device</span>;
          }

          const iso = context.getValue();
          if (iso === null) {
            return <span className="text-muted-foreground">Never reported</span>;
          }

          return <RelativeTime iso={iso} className="tabular text-muted-foreground" />;
        },
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

  const filtersActive = activeFilterLabels.length > 0;
  const visibleColumns = table.getVisibleFlatColumns();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader
        title="People"
        // The conclusion in the place a description used to be. Until there is a roster
        // to conclude anything about — loading, failed, or a company with nobody in it
        // — the standing description of the page is the more useful sentence.
        subtitle={health.people === 0 ? ROSTER_SUBTITLE : rosterSentence(health)}
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
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                Showing <span className="tabular text-foreground">{filtered.length}</span> of{" "}
                <span className="tabular">{rows.length}</span>
              </span>
              {filtersActive ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="min-w-0">filtered by {activeFilterLabels.join(", ")}</span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="rounded font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </div>
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
                  {/* The shared empty surface rather than a fourth hand-rolled one.
                      `bordered={false}` because the table already draws the panel, and
                      `p-0` so the cell does not pad it a second time. */}
                  <TableCell colSpan={visibleColumns.length} className="p-0">
                    <EmptyState
                      bordered={false}
                      title={rows.length === 0 ? "No employees yet" : "No one matches these filters"}
                      body={
                        rows.length > 0
                          ? `Nothing here matches ${activeFilterLabels.join(", ")}. Widen one of them, or clear them all and start again.`
                          : canManage
                            ? "Add the first person and their account is created from here. Nothing is collected until they sign in on a device and accept the monitoring policy."
                            : "Nobody has been added to this company yet. A super admin can add people from this screen; they appear here as soon as the account exists, before any device enrols."
                      }
                      action={
                        rows.length === 0 && canManage ? (
                          <Button type="button" onClick={() => setAddOpen(true)}>
                            <Plus className="h-4 w-4" aria-hidden />
                            Add person
                          </Button>
                        ) : filtersActive && rows.length > 0 ? (
                          <Button type="button" variant="outline" onClick={clearFilters}>
                            Clear filters
                          </Button>
                        ) : undefined
                      }
                    />
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
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader title="People" subtitle={ROSTER_SUBTITLE} />
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
