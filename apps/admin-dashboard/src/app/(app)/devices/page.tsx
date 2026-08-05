"use client";

import { Badge, cn } from "@aems/ui";
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
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, SlidersHorizontal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, useState } from "react";

import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  FilterBarSkeleton,
  StaleNotice,
  TableSkeleton,
  TableSkeletonRows,
  type SkeletonColumn,
} from "@/components/states";
import { describeError, useDevices, useEmployees, useSession, apiFetch, type DeviceRow } from "@/lib/api";
import { relativeTime } from "@/lib/format";
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

/**
 * Device inventory, `docs/scope.md` §7.
 *
 * Reads as an IT asset list rather than a people list — hardware first, person
 * second, per `docs/design.md`'s Datadog-infrastructure reference. Sorting and
 * column visibility come from TanStack Table; the filters live in the URL, so
 * "every revoked Windows machine" is a link.
 */
export default function DevicesPage() {
  return (
    <Suspense fallback={<DevicesSkeleton />}>
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

const COLUMN_LABELS: Record<string, string> = {
  device: "Device",
  owner: "Assigned to",
  platform: "Platform",
  cpu: "CPU",
  ram: "RAM",
  battery: "Battery",
  network: "Network",
  storageFree: "Free storage",
  status: "Status",
  lastSeen: "Last heartbeat",
  actions: "Actions",
};

/** The header row, reused by the route-level skeleton so nothing shifts on load. */
const SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { key: "device", label: "Device", lines: 2, width: "w-40" },
  { key: "owner", label: "Assigned to", width: "w-28" },
  { key: "platform", label: "Platform", width: "w-24" },
  { key: "cpu", label: "CPU", width: "w-28" },
  { key: "ram", label: "RAM", width: "w-12" },
  { key: "battery", label: "Battery", width: "w-16" },
  { key: "network", label: "Network", width: "w-16" },
  { key: "storageFree", label: "Free storage", width: "w-16" },
  { key: "status", label: "Status", width: "w-16" },
  { key: "lastSeen", label: "Last heartbeat", align: "right", width: "w-24" },
];

const TABLE_MIN_WIDTH = "min-w-[76rem]";

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
 * Not a micro-optimisation. This object is a dependency of the column definitions,
 * and `?? {}` mints a new one on every render — which rebuilds every column, which
 * resets the table, on every render. The same trap `useColumnVisibility` exists to
 * avoid, one file over.
 */
const NO_TELEMETRY: Record<string, TelemetrySnapshot> = {};

/**
 * A cap on how far back one request looks, not a cap on devices.
 *
 * Telemetry is an append-only series, so "the latest row per device" has no
 * PostgREST expression — the newest N rows are fetched and reduced here instead. A
 * device that has been silent for longer than the newest 2000 samples shows a dash,
 * which is the honest answer for a machine that has stopped reporting anyway.
 */
const TELEMETRY_ROW_CAP = 2000;

/**
 * Latest battery / network / storage per device.
 *
 * Read straight from Supabase under the signed-in user's own JWT rather than through
 * the API: `device_telemetry` has an RLS select policy (own devices, or the whole
 * company for a manager), so the browser cannot see a row the API would have hidden.
 * The API has no read endpoint for this series — see the note in the handover; when
 * one exists this should move behind it so the dashboard has a single data path.
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
        .select("device_id, recorded_at, battery_level, battery_charging, network_type, storage_free_mb")
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

  const { data, isLoading, isError, error, refetch } = useDevices();
  const rows = useMemo(() => data ?? [], [data]);

  // The devices payload carries only `profile_id`. The roster resolves it to a name
  // so the inventory reads "Ada Lovelace" rather than a UUID; if that query fails
  // the column falls back to a dash instead of taking the page down with it.
  const roster = useEmployees();
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
            <p className="text-xs text-muted-foreground">
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
      // -- Reported telemetry, scope §3.3 / §7. Sorted on the raw number so a
      // -- 9% battery does not sort between 80% and 90% as a string would.
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
              variant={status === "active" ? "online" : status === "revoked" ? "revoked" : "offline"}
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
          <span className="tabular text-muted-foreground">{relativeTime(context.getValue())}</span>
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
  const columnCount = visibleColumns.length;

  // The body skeleton has to line up with whatever columns are currently visible,
  // not with the fixed set the route-level fallback draws.
  const loadingColumns: SkeletonColumn[] = visibleColumns.map((column) => ({
    key: column.id,
    label: COLUMN_LABELS[column.id] ?? column.id,
    ...(column.id === "device" ? { lines: 2 as const, width: "w-40" } : {}),
    ...(column.id === "lastSeen" ? { align: "right" as const, width: "w-24" } : {}),
  }));

  return (
    <div className="mx-auto max-w-7xl px-6 py-7">
      <PageHeader title="Devices" subtitle="Company-owned hardware reporting into AEMS." />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <SearchField filters={filters} onChange={setFilters} />

        <PlatformField
          filters={filters}
          platforms={platforms}
          onChange={setFilters}
          disabled={isLoading || isError}
        />

        <StatusField filters={filters} onChange={setFilters} />

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
      </div>

      {isError ? (
        <ErrorState
          title="The device inventory could not be loaded"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          {/* Telemetry is a second request against a second table. It failing costs
              three columns, not the inventory — so it is said out loud and the rest
              of the table stays up. */}
          {telemetry.isError ? (
            <StaleNotice
              className="mb-2 rounded-md border"
              message="Battery, network and free storage could not be read. Every other column is current."
              onRetry={() => void telemetry.refetch()}
            />
          ) : null}

          {!isLoading && rows.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Showing <span className="tabular">{filtered.length}</span> of{" "}
              <span className="tabular">{rows.length}</span>
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className={cn("w-full text-sm", TABLE_MIN_WIDTH)}>
              <caption className="sr-only">
                Enrolled devices, sortable by name, owner, platform, hardware, reported
                telemetry, status and last heartbeat
              </caption>
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr
                    key={group.id}
                    className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    {group.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const right = header.column.id === "lastSeen";
                      const sortable = header.column.getCanSort();

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
                          className={cn("px-4 py-2 font-medium", right && "text-right")}
                        >
                          {sortable ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className="inline-flex items-center gap-1 rounded uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {isLoading ? (
                  <TableSkeletonRows columns={loadingColumns} rows={5} />
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="p-0">
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
                                <button
                                  type="button"
                                  onClick={() =>
                                    setFilters({ search: "", platform: null, status: null })
                                  }
                                  className="rounded text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  Clear filters
                                </button>
                              ),
                            }
                          : {})}
                      />
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

/* -------------------------------------------------------------------------- */
/* Revoking a device                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The way out of non-negotiable #4, "revocation is immediate".
 *
 * The table already rendered a `revoked` badge and offered a `revoked` filter for a
 * state nothing in the product could put a device into — the guarantee was written
 * in the copy and reachable only with `curl`. `POST /api/devices/:deviceId/revoke`
 * has existed all along; this is the button for it. The API writes the audit entry
 * and stops the agent on its next request.
 *
 * Confirmation is a second click on the row rather than `window.confirm`: a native
 * dialog blocks the whole window, reads as a browser warning rather than as part of
 * the product, and is exactly the modal `docs/design.md` asks the dashboard not to
 * throw at people.
 */
function RevokeCell({ device }: { device: DeviceRow }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const revoke = useMutation({
    mutationFn: () => apiFetch<{ ok: true }>(`/api/devices/${device.id}/revoke`, { method: "POST" }),
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
    return <span className="text-xs text-muted-foreground">Revoking…</span>;
  }

  if (confirming) {
    return (
      <span className="flex flex-col items-start gap-1">
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => revoke.mutate()}
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
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
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Revoke
      </button>
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

const selectClass =
  "h-9 rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

function SearchField({
  filters,
  onChange,
}: {
  filters: DeviceFilters;
  onChange: (next: DeviceFilters) => void;
}) {
  const id = useId();

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        id={id}
        type="search"
        value={filters.search}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
        placeholder="Search device, model or CPU"
        aria-label="Search devices"
        className="h-9 w-72 rounded-md border border-input bg-card pl-8 pr-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      />
    </div>
  );
}

function PlatformField({
  filters,
  platforms,
  onChange,
  disabled,
}: {
  filters: DeviceFilters;
  platforms: DeviceRow["platform"][];
  onChange: (next: DeviceFilters) => void;
  disabled: boolean;
}) {
  const id = useId();

  return (
    <div>
      <label htmlFor={id} className="sr-only">
        Platform
      </label>
      <select
        id={id}
        value={filters.platform ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            platform: (event.target.value || null) as DeviceFilters["platform"],
          })
        }
        disabled={disabled || platforms.length === 0}
        className={selectClass}
      >
        <option value="">All platforms</option>
        {platforms.map((platform) => (
          <option key={platform} value={platform}>
            {PLATFORM_LABEL[platform]}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatusField({
  filters,
  onChange,
}: {
  filters: DeviceFilters;
  onChange: (next: DeviceFilters) => void;
}) {
  const id = useId();

  return (
    <div>
      <label htmlFor={id} className="sr-only">
        Status
      </label>
      <select
        id={id}
        value={filters.status ?? ""}
        onChange={(event) =>
          onChange({ ...filters, status: (event.target.value || null) as DeviceFilters["status"] })
        }
        className={selectClass}
      >
        <option value="">Any status</option>
        <option value="active">Active</option>
        <option value="offline">Offline</option>
        <option value="revoked">Revoked</option>
      </select>
    </div>
  );
}

/**
 * The route-level fallback, which used to be two empty bordered boxes.
 *
 * A 9rem strip and a 16rem block do not occupy the space of a filter row and a
 * ten-column table, so the page collapsed and then jumped when `useSearchParams`
 * resolved. This is the real filter bar and the real header, with placeholder rows
 * underneath.
 */
function DevicesSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-7">
      <PageHeader title="Devices" subtitle="Company-owned hardware reporting into AEMS." />
      <span className="sr-only" role="status">
        Loading the device inventory
      </span>
      <FilterBarSkeleton fields={3} trailing />
      <TableSkeleton
        columns={SKELETON_COLUMNS}
        rows={5}
        minWidthClass={TABLE_MIN_WIDTH}
        caption="Loading enrolled devices"
      />
    </div>
  );
}
