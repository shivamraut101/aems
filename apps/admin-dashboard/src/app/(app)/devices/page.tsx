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
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, SlidersHorizontal } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { describeError, useDevices, useEmployees, type DeviceRow } from "@/lib/api";
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
  status: "Status",
  lastSeen: "Last heartbeat",
};

function DevicesScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  const columnVisibility = useColumnVisibility("devices");
  const setColumnVisibility = useFilters((state) => state.setColumnVisibility);
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastSeen", desc: true }]);

  const { data, isLoading, isError, error } = useDevices();
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

  const columns = useMemo(
    () => [
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
    ],
    [owners],
  );

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
  const columnCount = table.getVisibleFlatColumns().length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
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
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          {describeError(error)}
        </p>
      ) : (
        <>
          {!isLoading && rows.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Showing <span className="tabular">{filtered.length}</span> of{" "}
              <span className="tabular">{rows.length}</span>
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[52rem] text-sm">
              <caption className="sr-only">
                Enrolled devices, sortable by name, owner, platform, hardware, status and last
                heartbeat
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
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 5 }, (_, index) => (
                    <tr key={index} className="border-b last:border-0">
                      <td colSpan={columnCount} className="px-4 py-2.5">
                        <span className="block h-4 w-full animate-pulse rounded bg-muted" />
                      </td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="px-4 py-12 text-center">
                      <p className="text-sm font-medium">
                        {rows.length === 0 ? "No devices enrolled" : "No devices match these filters"}
                      </p>
                      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                        {rows.length === 0
                          ? "Install the desktop agent and sign in on the machine. It enrols itself, then appears here with its hardware details."
                          : "Try a different platform or status."}
                      </p>
                      {filtersActive && rows.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setFilters({ search: "", platform: null, status: null })}
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

function DevicesSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader title="Devices" subtitle="Company-owned hardware reporting into AEMS." />
      <div className="h-9 w-72 rounded-md border border-input bg-card" />
      <div className="mt-4 h-64 rounded-lg border bg-card" />
    </div>
  );
}
