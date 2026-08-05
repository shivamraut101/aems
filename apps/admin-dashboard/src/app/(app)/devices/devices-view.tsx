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
import { apiFetch, describeError, useApiQuery, useSession, type DeviceRow } from "@/lib/api";
import {
  compareLastSeen,
  deviceFilterParams,
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

function batteryLabel(snapshot: TelemetrySnapshot | undefined): string {
  if (!snapshot || snapshot.batteryLevel === null) return "—";
  return snapshot.batteryCharging === true
    ? `${snapshot.batteryLevel}% · charging`
    : `${snapshot.batteryLevel}%`;
}

function networkLabel(snapshot: TelemetrySnapshot | undefined): string {
  if (!snapshot || !snapshot.networkType) return "—";
  return NETWORK_LABEL[snapshot.networkType] ?? snapshot.networkType;
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
        cell: (context) => (
          <>
            <span className="font-medium">{context.getValue()}</span>
            <p className="truncate text-xs text-muted-foreground">
              {context.row.original.model ?? "Unknown model"} · agent{" "}
              {context.row.original.agent_version || "—"}
            </p>
          </>
        ),
      }),
      columnHelper.accessor((row) => owners.get(row.profile_id) ?? "—", {
        id: "owner",
        header: "Assigned to",
        cell: (context) => <span className="text-muted-foreground">{context.getValue()}</span>,
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
        cell: (context) => <span className="text-muted-foreground">{context.getValue()}</span>,
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
        cell: (context) => (
          <span className="tabular text-muted-foreground">
            {batteryLabel(snapshots[context.row.original.id])}
          </span>
        ),
      }),
      columnHelper.accessor((row) => networkLabel(snapshots[row.id]), {
        id: "network",
        header: "Network",
        cell: (context) => <span className="text-muted-foreground">{context.getValue()}</span>,
      }),
      columnHelper.accessor((row) => snapshots[row.id]?.storageFreeMb ?? -1, {
        id: "storageFree",
        header: "Free storage",
        cell: (context) => {
          const free = snapshots[context.row.original.id]?.storageFreeMb ?? null;
          return <span className="tabular text-muted-foreground">{gigabytes(free)}</span>;
        },
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Status",
        cell: (context) => {
          const status = context.getValue();
          return (
            <Badge
              variant={
                status === "active" ? "online" : status === "revoked" ? "revoked" : "offline"
              }
            >
              {status}
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
    <div className="mx-auto max-w-7xl px-6 py-7">
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

          {state !== "loading" && rows.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Showing <span className="tabular">{filtered.length}</span> of{" "}
              <span className="tabular">{rows.length}</span>
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
                                onClick={() =>
                                  setFilters({ search: "", platform: null, status: null })
                                }
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
    <div className="mx-auto max-w-7xl px-6 py-7">
      <PageHeader title="Devices" subtitle="Company-owned hardware reporting into AEMS." />
      <span className="sr-only" role="status">
        Loading the device inventory
      </span>
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
