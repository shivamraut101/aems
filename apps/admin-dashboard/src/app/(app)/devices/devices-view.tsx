"use client";

import {
  Badge,
  Button,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { Loader2, MonitorSmartphone, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  FilterBarSkeleton,
  SkeletonBar,
  StaleNotice,
  queryViewState,
} from "@/components/states";
import { apiFetch, describeError, useApiQuery, useSession, type DeviceRow } from "@/lib/api";
import {
  compareLastSeen,
  deviceFilterParams,
  EMPTY_DEVICE_FILTERS,
  gigabytes,
  matchesDeviceFilter,
  parseDeviceFilters,
  platformOptions,
  type DeviceFilters,
} from "@/lib/queries/roster-view";
import { createClient } from "@/lib/supabase";
import { mergeQuery, useColumnVisibility, useFilters } from "@/store/filters";

import { AddDeviceDialog } from "./add-device-dialog";
import {
  DEVICE_COLUMNS,
  DEVICE_COLUMN_CLASS,
  DEVICE_COLUMN_LABEL,
  DEVICE_TABLE_MIN_WIDTH,
  columnWidthNote,
} from "./columns";
import { devicesQuery, employeesQuery } from "./queries";

/**
 * Device inventory, `docs/scope.md` §7 — client half.
 *
 * Reads as an IT asset list rather than a people list — hardware first, person second,
 * per `docs/design.md`'s Datadog-infrastructure reference. Sorting and column
 * visibility come from TanStack Table; the filters live in the URL, so "every revoked
 * Windows machine" is a link.
 *
 * Both of its API reads are warmed by `page.tsx`, so the table is populated in the
 * first paint rather than after it.
 */
export function DevicesView() {
  return (
    <Suspense fallback={<DevicesFallback />}>
      <DevicesScreen />
    </Suspense>
  );
}

const columnHelper = createColumnHelper<DeviceRow>();

const PLATFORM_LABEL: Record<DeviceRow["platform"], string> = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
};

/**
 * Status, as a sentence-cased word rather than the wire value.
 *
 * The badge printed `active` in the same lower-case the column stores, which is the only
 * place in the product where a reader is shown a database value verbatim.
 */
const STATUS_LABEL: Record<DeviceRow["status"], string> = {
  active: "Active",
  offline: "Offline",
  revoked: "Revoked",
};

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                   */
/* -------------------------------------------------------------------------- */

const NETWORK_LABEL: Record<string, string> = {
  wifi: "Wi-Fi",
  cellular: "Cellular",
  ethernet: "Ethernet",
  offline: "Offline",
};

export interface TelemetrySnapshot {
  recordedAt: string;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  networkType: string | null;
  storageFreeMb: number | null;
}

/** The columns asked for, named as the table names them. */
interface TelemetryWireRow {
  device_id: string;
  recorded_at: string;
  battery_level: number | null;
  battery_charging: boolean | null;
  network_type: string | null;
  storage_free_mb: number | null;
}

/**
 * One shared empty map for "telemetry has not answered yet".
 *
 * Not a micro-optimisation. This object is a dependency of the column definitions, and
 * `?? {}` mints a new one on every render — which rebuilds every column, which resets
 * the table, on every render. The same trap `useColumnVisibility` exists to avoid, one
 * file over.
 */
const NO_TELEMETRY: Record<string, TelemetrySnapshot> = {};

/**
 * A cap on how far back one request looks, not a cap on devices.
 *
 * Telemetry is an append-only series, so "the latest row per device" has no PostgREST
 * expression — the newest N rows are fetched and reduced here instead. A device that
 * has been silent for longer than the newest 2000 samples shows a dash, which is the
 * honest answer for a machine that has stopped reporting anyway.
 */
const TELEMETRY_ROW_CAP = 2000;

/**
 * Latest battery / network / storage per device.
 *
 * Read straight from Supabase under the signed-in user's own JWT rather than through
 * the API: `device_telemetry` has an RLS select policy (own devices, or the whole
 * company for a manager), so the browser cannot see a row the API would have hidden.
 * The API has no read endpoint for this series — when one exists this should move
 * behind it so the dashboard has a single data path, and so it can be prefetched with
 * the other two.
 */
function useLatestTelemetry(deviceIds: readonly string[]) {
  const ids = useMemo(() => [...deviceIds].sort(), [deviceIds]);

  return useQuery({
    queryKey: ["device-telemetry", ids],
    enabled: ids.length > 0,
    // Battery and network move slowly, and this table is not a live view.
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, TelemetrySnapshot>> => {
      const { data, error } = await createClient()
        .from("device_telemetry")
        .select(
          "device_id, recorded_at, battery_level, battery_charging, network_type, storage_free_mb",
        )
        .in("device_id", ids as string[])
        .order("recorded_at", { ascending: false })
        .limit(TELEMETRY_ROW_CAP)
        .returns<TelemetryWireRow[]>();

      if (error) throw new Error(error.message);

      const latest: Record<string, TelemetrySnapshot> = {};
      // Descending by time, so the first row seen for a device is its newest.
      for (const row of data ?? []) {
        if (latest[row.device_id]) continue;
        latest[row.device_id] = {
          recordedAt: row.recorded_at,
          batteryLevel: row.battery_level,
          batteryCharging: row.battery_charging,
          networkType: row.network_type,
          storageFreeMb: row.storage_free_mb,
        };
      }
      return latest;
    },
  });
}

/**
 * What an empty telemetry cell means, which an em dash on its own cannot say.
 *
 * These three columns read as "Android-only fields dashed out on every desktop row",
 * and that is not what they are: `desktop-agent/src/main/telemetry.ts` reports battery,
 * network and free storage on Windows and macOS as well, on the heartbeat cadence. So a
 * blank cell is never "the wrong column for this platform" — it is one of two separate
 * facts, and the table used to print the same character for both.
 *
 * A device that has sent no sample at all gets the dash, and the row says so once in
 * {@link telemetryTitle} rather than three times across three columns. A device that
 * sent a sample with no battery in it is a desktop PC or a Mac mini, and "No battery" is
 * the honest reading of that — the agent goes out of its way not to claim a charging
 * state for a machine with nothing to charge, and the dashboard should not undo it by
 * showing the same gap it shows for silence.
 */
function batteryLabel(snapshot: TelemetrySnapshot | undefined): string {
  if (!snapshot) return "—";
  if (snapshot.batteryLevel === null) return "No battery";
  return snapshot.batteryCharging === true
    ? `${snapshot.batteryLevel}% · charging`
    : `${snapshot.batteryLevel}%`;
}

function networkLabel(snapshot: TelemetrySnapshot | undefined): string {
  if (!snapshot) return "—";
  // The agent answers `null` when the adapter's name does not prove what the link is,
  // deliberately — see the note on `networkTypeFrom`. That is "we do not know", not
  // "nothing was reported", and the two must not print the same.
  if (!snapshot.networkType) return "Unknown";
  return NETWORK_LABEL[snapshot.networkType] ?? snapshot.networkType;
}

/**
 * The hover text on a telemetry cell: which sample it came from, or that there is none.
 *
 * `recordedAt` is already in hand and was never shown. Battery and network are only true
 * at the instant they were read, so a percentage with no age on it is a reading a manager
 * cannot weigh — and on a machine that stopped reporting yesterday it is actively
 * misleading.
 */
function telemetryTitle(snapshot: TelemetrySnapshot | undefined): string {
  if (!snapshot) return "This device has not reported battery, network or storage yet.";
  return `Reported ${new Date(snapshot.recordedAt).toLocaleString()}`;
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

function DevicesScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  const columnVisibility = useColumnVisibility("devices");
  const setColumnVisibility = useFilters((state) => state.setColumnVisibility);
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastSeen", desc: true }]);
  const [addOpen, setAddOpen] = useState(false);

  const devices = useApiQuery(devicesQuery);
  const rows = useMemo(() => devices.data ?? [], [devices.data]);
  const state = queryViewState(devices);

  // The devices payload carries only `profile_id`. The roster resolves it to a name so
  // the inventory reads "Ada Lovelace" rather than a uuid; if that query fails the
  // column falls back to a dash instead of taking the page down with it.
  const roster = useApiQuery(employeesQuery);
  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of roster.data ?? []) map.set(person.id, person.full_name || person.email);
    return map;
  }, [roster.data]);

  const deviceIds = useMemo(() => rows.map((device) => device.id), [rows]);
  const telemetry = useLatestTelemetry(deviceIds);
  const snapshots = telemetry.data ?? NO_TELEMETRY;

  // `POST /api/devices/:deviceId/revoke` is behind `requireSuperAdmin`. Showing the
  // control to a manager would be offering them a 403.
  const session = useSession();
  const canRevoke = session.data?.role === "super_admin";

  const filters = useMemo(
    () =>
      parseDeviceFilters({
        q: searchParams.get("q"),
        platform: searchParams.get("platform"),
        status: searchParams.get("status"),
      }),
    [searchParams],
  );

  function setFilters(next: DeviceFilters) {
    const query = mergeQuery(search, deviceFilterParams(next));
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const platforms = useMemo(() => platformOptions(rows), [rows]);
  const filtered = useMemo(
    () => rows.filter((device) => matchesDeviceFilter(device, filters)),
    [rows, filters],
  );

  const columns = useMemo(() => {
    const base = [
      columnHelper.accessor((row) => row.device_name || row.label, {
        id: "device",
        header: "Device",
        // The primary cell is the way in. There is no per-device route, so the nearest
        // thing to "open this machine" is its owner's Devices tab, which is where the
        // full detail for one device already lives — the same set this table hides at
        // narrow widths. A row that shows a summary and cannot be opened is a dead end.
        cell: (context) => {
          const device = context.row.original;
          const name = context.getValue();

          return (
            <>
              <Link
                href={`/people/${device.profile_id}/devices`}
                title={name}
                className="block truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {name}
              </Link>
              <p
                className="truncate text-xs text-muted-foreground"
                title={`${device.model ?? "Unknown model"} · agent ${device.agent_version || "unknown"}`}
              >
                {device.model ?? "Unknown model"} · agent {device.agent_version || "—"}
              </p>
            </>
          );
        },
      }),
      columnHelper.accessor((row) => owners.get(row.profile_id) ?? "—", {
        id: "owner",
        header: "Assigned to",
        cell: (context) => {
          const name = context.getValue();
          // A dash here means the roster did not resolve the id — the row still knows
          // whose it is, so the link stands either way rather than stranding the reader
          // on the one column that failed.
          return (
            <Link
              href={`/people/${context.row.original.profile_id}`}
              title={name === "—" ? "Open this device's owner" : name}
              className="block truncate rounded-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {name}
            </Link>
          );
        },
      }),
      columnHelper.accessor("platform", {
        id: "platform",
        header: "Platform",
        cell: (context) => (
          <span className="text-muted-foreground">
            {PLATFORM_LABEL[context.getValue()]} {context.row.original.os_version}
          </span>
        ),
      }),
      columnHelper.accessor((row) => row.cpu ?? "—", {
        id: "cpu",
        header: "CPU",
        cell: (context) => (
          // A CPU string is "12th Gen Intel(R) Core(TM) i7-1265U" — 36 characters in a
          // 140px budget. Clipped with the full value one hover away, rather than
          // wrapped to three lines and dragging every other row's height with it.
          <span
            className="block truncate text-muted-foreground"
            title={context.row.original.cpu ?? "The agent has not reported this machine's CPU."}
          >
            {context.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor((row) => row.ram_mb ?? 0, {
        id: "ram",
        header: "RAM",
        cell: (context) => (
          <span className="tabular text-muted-foreground">
            {gigabytes(context.row.original.ram_mb)}
          </span>
        ),
      }),
      // -- Reported telemetry, scope §3.3 / §7. Sorted on the raw number so a 9%
      // -- battery does not sort between 80% and 90% as a string would.
      columnHelper.accessor((row) => snapshots[row.id]?.batteryLevel ?? -1, {
        id: "battery",
        header: "Battery",
        cell: (context) => {
          const snapshot = snapshots[context.row.original.id];
          return (
            <span className="tabular text-muted-foreground" title={telemetryTitle(snapshot)}>
              {batteryLabel(snapshot)}
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => networkLabel(snapshots[row.id]), {
        id: "network",
        header: "Network",
        cell: (context) => (
          <span
            className="text-muted-foreground"
            title={telemetryTitle(snapshots[context.row.original.id])}
          >
            {context.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor((row) => snapshots[row.id]?.storageFreeMb ?? -1, {
        id: "storageFree",
        header: "Free storage",
        cell: (context) => {
          const snapshot = snapshots[context.row.original.id];
          return (
            <span className="tabular text-muted-foreground" title={telemetryTitle(snapshot)}>
              {gigabytes(snapshot?.storageFreeMb ?? null)}
            </span>
          );
        },
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Status",
        cell: (context) => {
          const status = context.getValue();
          return (
            // `dot`, because this is a *state* a machine is in right now rather than a
            // label it carries — the same distinction the roster's Active/Idle pills draw.
            <Badge
              dot
              variant={
                status === "active" ? "online" : status === "revoked" ? "revoked" : "offline"
              }
            >
              {STATUS_LABEL[status]}
            </Badge>
          );
        },
      }),
      columnHelper.accessor((row) => row.last_seen_at, {
        id: "lastSeen",
        header: "Last heartbeat",
        sortingFn: (a, b) =>
          compareLastSeen(
            a.getValue<string | null>("lastSeen"),
            b.getValue<string | null>("lastSeen"),
          ),
        cell: (context) => (
          <RelativeTime iso={context.getValue()} className="tabular text-muted-foreground" />
        ),
      }),
    ];

    if (!canRevoke) return base;

    return [
      ...base,
      columnHelper.display({
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: (context) => <RevokeCell device={context.row.original} />,
      }),
    ];
  }, [owners, snapshots, canRevoke]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) => {
      const next: VisibilityState =
        typeof updater === "function" ? updater(columnVisibility) : updater;
      setColumnVisibility("devices", next);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const filtersActive =
    filters.search !== "" || filters.platform !== null || filters.status !== null;
  const visibleColumns = table.getVisibleFlatColumns();

  return (
    // `px-4` below `sm`, matching the Overview: 16px of gutter rather than 24px gives a
    // 390px phone another 32px of table before it has to scroll inside its own box.
    // `max-w-7xl` stays, and is the one place this page departs from the Overview's
    // `max-w-6xl` — the eleven-column inventory declares a 77rem minimum at `2xl`, which
    // fits inside 1280px of container and does not fit inside 1152px. `table-layout.test.ts`
    // checks that arithmetic against this exact cap.
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader
        title="Devices"
        subtitle="Company-owned hardware reporting into AEMS."
        actions={
          <Button type="button" onClick={() => setAddOpen(true)}>
            <MonitorSmartphone className="h-4 w-4" aria-hidden />
            Add device
          </Button>
        }
      />

      {/* Not gated on role. Everyone may enrol their OWN machine — that is the
          self-service path — and the API refuses a code for anyone else unless the
          caller is a manager. Hiding this from employees would leave them unable to set
          up the laptop they were handed. */}
      {addOpen ? <AddDeviceDialog onClose={() => setAddOpen(false)} /> : null}

      {/* "0 of 0 reporting" is a claim, not a placeholder, so a load gets the card's
          height and none of its words. An empty company gets neither: the empty state
          in the table already says what would put a device here, and a conclusion about
          nothing above it would only be in the way. */}
      {state === "loading" ? (
        <InventorySummarySkeleton />
      ) : state !== "error" && rows.length > 0 ? (
        <InventorySummary
          rows={rows}
          onShowStatus={(status) => setFilters({ ...filters, status })}
        />
      ) : null}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchField filters={filters} onChange={setFilters} />

        <Select
          value={filters.platform ?? ANY_PLATFORM}
          onValueChange={(value) =>
            setFilters({
              ...filters,
              platform: (value === ANY_PLATFORM ? null : value) as DeviceFilters["platform"],
            })
          }
          disabled={state === "loading" || state === "error" || platforms.length === 0}
        >
          <SelectTrigger aria-label="Filter by platform" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_PLATFORM}>All platforms</SelectItem>
            {platforms.map((platform) => (
              <SelectItem key={platform} value={platform}>
                {PLATFORM_LABEL[platform]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.status ?? ANY_STATUS}
          onValueChange={(value) =>
            setFilters({
              ...filters,
              status: (value === ANY_STATUS ? null : value) as DeviceFilters["status"],
            })
          }
        >
          <SelectTrigger aria-label="Filter by status" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_STATUS}>Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>

        <ColumnsMenu table={table} />
      </div>

      {state === "error" ? (
        <ErrorState
          title="The device inventory could not be loaded"
          message={describeError(devices.error)}
          onRetry={() => void devices.refetch()}
        />
      ) : (
        <>
          {state === "stale" ? (
            <StaleNotice
              className="mb-2 rounded-md border"
              message="This inventory could not be refreshed, so it may be a few minutes old."
              onRetry={() => void devices.refetch()}
            />
          ) : null}

          {/* Telemetry is a second request against a second table. It failing costs
              three columns, not the inventory — so it is said out loud and the rest of
              the table stays up. */}
          {telemetry.isError ? (
            <StaleNotice
              className="mb-2 rounded-md border"
              message="Battery, network and free storage could not be read. Every other column is current."
              onRetry={() => void telemetry.refetch()}
            />
          ) : null}

          {/* The roster failing was the one degradation this page did silently: every
              Assigned-to cell fell back to an em dash and nothing said why, so an outage
              looked like an estate of unassigned machines. */}
          {roster.isError ? (
            <StaleNotice
              className="mb-2 rounded-md border"
              message="Owner names could not be read, so the Assigned to column is showing dashes. Every other column is current."
              onRetry={() => void roster.refetch()}
            />
          ) : null}

          {state !== "loading" && rows.length > 0 ? (
            <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                Showing <span className="tabular">{filtered.length}</span> of{" "}
                <span className="tabular">{rows.length}</span>
              </span>
              {/* Said here as well as in the empty state, because a filter that hides
                  nine of eleven rows still leaves two on screen — and a table that
                  quietly answers a narrower question than the one asked is worse than
                  an obviously empty one. */}
              {filtersActive ? (
                <>
                  <span aria-hidden>·</span>
                  <span>Filtered</span>
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_DEVICE_FILTERS)}
                    className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </p>
          ) : null}

          <Table
            containerClassName="rounded-lg border bg-card"
            className={DEVICE_TABLE_MIN_WIDTH.className}
          >
            <caption className="sr-only">
              Enrolled devices, sortable by name, owner, platform, hardware, reported
              telemetry, status and last heartbeat
            </caption>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const right = header.column.id === "lastSeen";
                    const direction = sorted === false ? null : sorted;

                    return (
                      <TableHead
                        key={header.id}
                        scope="col"
                        sortDirection={header.column.getCanSort() ? direction : undefined}
                        className={cn(
                          DEVICE_COLUMN_CLASS[header.column.id],
                          right && "text-right",
                        )}
                      >
                        {header.column.getCanSort() ? (
                          <TableSortButton
                            direction={direction}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </TableSortButton>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
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
                  <TableCell colSpan={visibleColumns.length} className="p-0">
                    <EmptyState
                      bordered={false}
                      title={
                        rows.length === 0 ? "No devices enrolled" : "No devices match these filters"
                      }
                      body={
                        rows.length === 0
                          ? "Install the desktop agent and sign in on the machine. It enrols itself, then appears here with its hardware details."
                          : "Try a different platform or status."
                      }
                      {...(filtersActive && rows.length > 0
                        ? {
                            action: (
                              <Button
                                type="button"
                                variant="link"
                                onClick={() => setFilters(EMPTY_DEVICE_FILTERS)}
                              >
                                Clear filters
                              </Button>
                            ),
                          }
                        : {})}
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
                          DEVICE_COLUMN_CLASS[cell.column.id],
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

/* -------------------------------------------------------------------------- */
/* The conclusion                                                              */
/* -------------------------------------------------------------------------- */

interface StatusCounts {
  total: number;
  active: number;
  offline: number;
  revoked: number;
}

function countByStatus(rows: readonly DeviceRow[]): StatusCounts {
  const counts: StatusCounts = { total: rows.length, active: 0, offline: 0, revoked: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * What the inventory says before it lists anything.
 *
 * The question this page is opened with is "is every company machine still reporting?",
 * and eleven columns of hardware detail answer it only once they have all been read —
 * on a laptop, six of them at a time. The sentence answers it first and the table
 * becomes the evidence rather than the finding.
 *
 * Revoked machines are held out of the denominator deliberately. A revoked device is
 * *meant* to be silent — non-negotiable #4 — so counting it as a machine that failed to
 * report would turn a completed off-boarding into a warning, which is the one reading
 * that would make an administrator hesitate to revoke anything.
 *
 * Same treatment as the Overview's verdict block, on purpose: two pages that lead with
 * a conclusion should look like they were built by the same product.
 */
function InventorySummary({
  rows,
  onShowStatus,
}: {
  rows: readonly DeviceRow[];
  onShowStatus: (status: DeviceFilters["status"]) => void;
}) {
  const counts = useMemo(() => countByStatus(rows), [rows]);
  const expected = counts.total - counts.revoked;

  return (
    <section
      aria-label="Inventory at a glance"
      className="mb-6 rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="tabular text-2xl font-semibold tracking-[-0.025em] sm:text-[26px]">
          {counts.active} of {expected} reporting
        </h2>
        {counts.offline > 0 ? (
          <Badge variant="warning" dot>
            {counts.offline} not reporting
          </Badge>
        ) : expected > 0 ? (
          <Badge variant="success" dot>
            All reporting
          </Badge>
        ) : null}
      </div>

      <p className="mt-2 max-w-[64ch] text-sm text-muted-foreground">
        {counts.offline > 0 ? (
          <>
            {counts.offline === 1 ? "One machine has" : `${counts.offline} machines have`} stopped
            sending heartbeats.{" "}
            <SummaryFilterButton onClick={() => onShowStatus("offline")}>
              Show {counts.offline === 1 ? "it" : "them"}
            </SummaryFilterButton>
            .
          </>
        ) : expected === 0 ? (
          "No device is currently enrolled."
        ) : (
          "Every enrolled machine has sent a recent heartbeat."
        )}
        {counts.revoked > 0 ? (
          <>
            {" "}
            <SummaryFilterButton onClick={() => onShowStatus("revoked")}>
              {counts.revoked} revoked
            </SummaryFilterButton>{" "}
            {counts.revoked === 1 ? "device collects" : "devices collect"} nothing.
          </>
        ) : null}
      </p>

      <dl className="mt-5 flex flex-wrap gap-x-7 gap-y-3 border-t pt-4">
        {[
          { label: "Reporting", value: counts.active },
          { label: "Offline", value: counts.offline },
          { label: "Revoked", value: counts.revoked },
          { label: "Enrolled", value: counts.total },
        ].map((figure) => (
          <div key={figure.label}>
            <dd className="tabular text-base font-semibold tracking-[-0.02em] sm:text-[17px]">
              {figure.value}
            </dd>
            <dt className="text-[11px] text-muted-foreground">{figure.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The summary's own height, held while the inventory is still being read.
 *
 * Same reasoning as `DevicesFallback` below: a conclusion that appears above an already
 * drawn table pushes the whole page down a beat after it settled. This card is the one
 * thing on the screen whose height cannot be inferred from the columns, so it has to
 * stand its own.
 */
function InventorySummarySkeleton() {
  return (
    <section
      aria-hidden
      className="mb-6 rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6"
    >
      <SkeletonBar className="h-8 w-56 max-w-full" />
      <SkeletonBar className="mt-3 h-4 w-4/5 max-w-lg" />
      <div className="mt-5 flex flex-wrap gap-x-7 gap-y-3 border-t pt-4">
        {[0, 1, 2, 3].map((cell) => (
          <div key={cell}>
            <SkeletonBar className="h-5 w-10" />
            <SkeletonBar className="mt-1 h-3 w-14" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A count in the sentence that is also the filter for it.
 *
 * The status Select above already exists and is not duplicated here — this only drives
 * it, so the reader who has just been told two machines are silent does not then have to
 * find the control that shows them.
 */
function SummaryFilterButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Revoking a device                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The way out of non-negotiable #4, "revocation is immediate".
 *
 * The table already rendered a `revoked` badge and offered a `revoked` filter for a
 * state nothing in the product could put a device into — the guarantee was written in
 * the copy and reachable only with `curl`. `POST /api/devices/:deviceId/revoke` has
 * existed all along; this is the button for it. The API writes the audit entry and
 * stops the agent on its next request.
 *
 * Confirmation is a second click on the row rather than `window.confirm`: a native
 * dialog blocks the whole window, reads as a browser warning rather than as part of the
 * product, and is exactly the modal `docs/design.md` asks the dashboard not to throw at
 * people.
 */
function RevokeCell({ device }: { device: DeviceRow }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const revoke = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>(`/api/devices/${device.id}/revoke`, { method: "POST" }),
    onSuccess: async () => {
      setConfirming(false);
      // The row's own status, and the presence strip that counts active devices.
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
      await queryClient.invalidateQueries({ queryKey: ["analytics", "live"] });
    },
  });

  if (device.status === "revoked") {
    return <span className="text-xs text-muted-foreground">Revoked</span>;
  }

  if (revoke.isPending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Revoking…
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="flex flex-col items-start gap-1">
        {/* Default size, not `sm`. `sm` is `h-8` — 32px, under the 36px this product
            holds itself to for anything a finger has to hit, and this is the control
            that stops collection on somebody's laptop. */}
        <span className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="destructive" onClick={() => revoke.mutate()}>
            Confirm
          </Button>
          <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </span>
        <span className="max-w-[14rem] text-[11px] leading-snug text-muted-foreground">
          Collection stops on this device&apos;s next request. It cannot be undone from
          here.
        </span>
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
        Revoke
      </Button>
      {revoke.isError ? (
        <span role="alert" className="max-w-[14rem] text-[11px] leading-snug text-destructive">
          {describeError(revoke.error)}
        </span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Filter controls                                                             */
/* -------------------------------------------------------------------------- */

/** Radix refuses `value=""`, so "no filter" needs a name in both selects. */
const ANY_PLATFORM = "__all__";
const ANY_STATUS = "__any__";

/**
 * The search box, with the URL written a beat after the typing rather than on it.
 *
 * See the note on the roster's copy of this: the route renders dynamically, so a
 * `router.replace` per keystroke is an RSC round trip per keystroke. The URL stays the
 * source of truth — the effect follows it whenever it changes from anywhere else.
 */
function SearchField({
  filters,
  onChange,
}: {
  filters: DeviceFilters;
  onChange: (next: DeviceFilters) => void;
}) {
  const committed = filters.search;
  const [draft, setDraft] = useState(committed);

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
      placeholder="Search device, model or CPU"
      aria-label="Search devices"
      containerClassName="w-full sm:w-72"
    />
  );
}

/**
 * Column visibility.
 *
 * Was a `<details>` element. It could not be positioned — an absolutely positioned
 * panel hanging off a summary runs off the viewport when the control is near an edge,
 * and this one is pinned to the right-hand end of the filter bar, so it always is.
 * Radix portals it, flips it on collision and caps its height.
 *
 * The threshold beside a name says at what width the column is drawn at all. Ten of
 * these eleven columns exist on a 1536px screen and six on a 1024px one; without the
 * note, ticking "CPU" on a laptop appears to do nothing.
 */
function ColumnsMenu({ table }: { table: ReturnType<typeof useReactTable<DeviceRow>> }) {
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
            const note = columnWidthNote(column.id);

            return (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={column.getIsVisible()}
                onCheckedChange={(value) => column.toggleVisibility(value === true)}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="flex w-full items-center gap-3">
                  <span className="min-w-0 truncate">
                    {DEVICE_COLUMN_LABEL[column.id] ?? column.id}
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

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder rows shaped to the columns currently on screen.
 *
 * Local rather than `TableSkeletonRows` because those cells cannot carry the responsive
 * classes, and a placeholder standing in a column the viewport hides is a row of the
 * wrong width. Rarely seen: both reads are prefetched on the server.
 */
function LoadingRows({ columnIds, rows = 5 }: { columnIds: readonly string[]; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <TableRow key={rowIndex} className="hover:bg-transparent" aria-hidden>
          {columnIds.map((id) => (
            <TableCell
              key={id}
              className={cn(
                "align-top",
                DEVICE_COLUMN_CLASS[id],
                id === "lastSeen" && "text-right",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3.5 animate-pulse rounded bg-muted align-middle",
                  id === "device" ? "w-36" : "w-16",
                )}
              />
              {id === "device" ? (
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
 * The Suspense fallback, which used to be two empty bordered boxes.
 *
 * A 9rem strip and a 16rem block do not occupy the space of a filter row and a
 * ten-column table, so the page collapsed and then jumped. This is the real filter bar
 * and the real header, with placeholder rows underneath.
 */
function DevicesFallback() {
  return (
    // Must match `DevicesScreen`'s container exactly, or the page shifts as it resolves.
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader title="Devices" subtitle="Company-owned hardware reporting into AEMS." />
      <span className="sr-only" role="status">
        Loading the device inventory
      </span>
      <InventorySummarySkeleton />
      <FilterBarSkeleton fields={3} />
      <Table
        containerClassName="rounded-lg border bg-card"
        className={DEVICE_TABLE_MIN_WIDTH.className}
      >
        <caption className="sr-only">Loading enrolled devices</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {DEVICE_COLUMNS.map((column) => (
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
          <LoadingRows columnIds={DEVICE_COLUMNS.map((column) => column.id)} />
        </TableBody>
      </Table>
    </div>
  );
}
