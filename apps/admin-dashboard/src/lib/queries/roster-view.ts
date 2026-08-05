import type { DeviceRow, EmployeeRow } from "@/lib/api";

/**
 * View models for the People and Devices tables.
 *
 * Pure functions, deliberately outside the components: filtering and sorting is the
 * only real logic on either screen, and a predicate is far easier to prove correct
 * here than through a rendered table. TanStack Table then owns sorting, column
 * visibility and row models, and these functions own what "matches" means.
 */

/** The bucket a person with no department falls into. Also its display label. */
export const UNASSIGNED_DEPARTMENT = "—";

export interface PeopleFilters {
  search: string;
  /** Exact department, or {@link UNASSIGNED_DEPARTMENT}. Null means every department. */
  department: string | null;
  monitoring: "all" | "on" | "paused";
}

export const EMPTY_PEOPLE_FILTERS: PeopleFilters = {
  search: "",
  department: null,
  monitoring: "all",
};

function contains(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle);
}

export function matchesPeopleFilter(person: EmployeeRow, filters: PeopleFilters): boolean {
  const needle = filters.search.trim().toLowerCase();
  if (needle) {
    const hit =
      contains(person.full_name, needle) ||
      contains(person.email, needle) ||
      contains(person.department, needle);
    if (!hit) return false;
  }

  if (filters.department !== null) {
    // Exact, not substring: a "Design" filter that also returned "Design Ops" makes
    // the department counts on this page disagree with the department itself.
    if (departmentOf(person) !== filters.department) return false;
  }

  if (filters.monitoring === "on" && !person.monitoring_enabled) return false;
  if (filters.monitoring === "paused" && person.monitoring_enabled) return false;

  return true;
}

/**
 * Filters live in the query string, the same discipline the range control follows:
 * "everyone in Support whose monitoring is paused" is a view a manager needs to be
 * able to send to someone, and a filter held in component state cannot be sent.
 */
export interface FilterQuery {
  [key: string]: string | null | undefined;
}

const MONITORING_VALUES: readonly PeopleFilters["monitoring"][] = ["all", "on", "paused"];

export function parsePeopleFilters(query: FilterQuery): PeopleFilters {
  const monitoring = query["monitoring"]?.trim() ?? "";
  const department = query["dept"]?.trim() ?? "";

  return {
    search: query["q"]?.trim() ?? "",
    department: department === "" ? null : department,
    monitoring: (MONITORING_VALUES as readonly string[]).includes(monitoring)
      ? (monitoring as PeopleFilters["monitoring"])
      : "all",
  };
}

export function peopleFilterParams(filters: PeopleFilters): Record<string, string | null> {
  return {
    q: filters.search.trim() || null,
    dept: filters.department,
    monitoring: filters.monitoring === "all" ? null : filters.monitoring,
  };
}

function departmentOf(person: EmployeeRow): string {
  const value = person.department?.trim() ?? "";
  return value === "" ? UNASSIGNED_DEPARTMENT : value;
}

/**
 * Every department present in the roster, sorted, with the unassigned bucket last.
 *
 * Derived from the payload the page already holds rather than fetched: a department
 * list that includes values nobody in this company uses is a filter that returns
 * nothing, which reads as a bug.
 */
export function departmentOptions(rows: readonly EmployeeRow[]): string[] {
  const named = new Set<string>();
  let unassigned = false;

  for (const row of rows) {
    const department = departmentOf(row);
    if (department === UNASSIGNED_DEPARTMENT) unassigned = true;
    else named.add(department);
  }

  const options = [...named].sort((a, b) => a.localeCompare(b));
  if (unassigned) options.push(UNASSIGNED_DEPARTMENT);
  return options;
}

function instant(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The newest heartbeat across a person's devices.
 *
 * Compared as instants rather than as text. The previous implementation sorted the
 * ISO strings, which is only right while every timestamp shares a format and an
 * offset — one `+02:00` row from a differently configured agent and the roster shows
 * the wrong "last seen".
 */
export function peopleLastSeen(person: EmployeeRow): string | null {
  let bestIso: string | null = null;
  let bestAt = -Infinity;

  for (const device of person.devices) {
    const at = instant(device.last_seen_at);
    if (at !== null && at > bestAt) {
      bestAt = at;
      bestIso = device.last_seen_at;
    }
  }

  return bestIso;
}

export function deviceLastSeen(device: DeviceRow): string | null {
  return device.last_seen_at;
}

/**
 * Ascending comparator for a "last seen" column.
 *
 * Never-seen sorts as the oldest possible moment, which is what it is — not as a
 * special case pinned to one end. Descending then puts the freshest first and the
 * silent machines last, which is the order someone scanning for trouble wants.
 */
export function compareLastSeen(a: string | null, b: string | null): number {
  const left = instant(a) ?? -Infinity;
  const right = instant(b) ?? -Infinity;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function monitoringSummary(rows: readonly EmployeeRow[]): {
  total: number;
  enabled: number;
  paused: number;
} {
  let enabled = 0;
  for (const row of rows) if (row.monitoring_enabled) enabled += 1;
  return { total: rows.length, enabled, paused: rows.length - enabled };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DevicePlatform = DeviceRow["platform"];
export type DeviceStatus = DeviceRow["status"];

export interface DeviceFilters {
  search: string;
  platform: DevicePlatform | null;
  status: DeviceStatus | null;
}

export const EMPTY_DEVICE_FILTERS: DeviceFilters = { search: "", platform: null, status: null };

export function matchesDeviceFilter(device: DeviceRow, filters: DeviceFilters): boolean {
  const needle = filters.search.trim().toLowerCase();
  if (needle) {
    const hit =
      contains(device.device_name, needle) ||
      contains(device.label, needle) ||
      contains(device.model, needle) ||
      contains(device.cpu, needle) ||
      contains(device.os_version, needle);
    if (!hit) return false;
  }

  if (filters.platform !== null && device.platform !== filters.platform) return false;
  if (filters.status !== null && device.status !== filters.status) return false;

  return true;
}

/** Fixed order so the control does not reshuffle as devices enrol and drop off. */
const PLATFORM_ORDER: readonly DevicePlatform[] = ["windows", "macos", "android"];
const DEVICE_STATUSES: readonly DeviceStatus[] = ["active", "offline", "revoked"];

export function parseDeviceFilters(query: FilterQuery): DeviceFilters {
  const platform = query["platform"]?.trim() ?? "";
  const status = query["status"]?.trim() ?? "";

  return {
    search: query["q"]?.trim() ?? "",
    platform: (PLATFORM_ORDER as readonly string[]).includes(platform)
      ? (platform as DevicePlatform)
      : null,
    status: (DEVICE_STATUSES as readonly string[]).includes(status)
      ? (status as DeviceStatus)
      : null,
  };
}

export function deviceFilterParams(filters: DeviceFilters): Record<string, string | null> {
  return {
    q: filters.search.trim() || null,
    platform: filters.platform,
    status: filters.status,
  };
}

export function platformOptions(rows: readonly DeviceRow[]): DevicePlatform[] {
  const present = new Set(rows.map((row) => row.platform));
  return PLATFORM_ORDER.filter((platform) => present.has(platform));
}

/**
 * Memory and storage, read as hardware rather than as a number.
 *
 * Zero and null both render as an em dash: "0 GB" claims a machine has no memory,
 * which is never true — it means the agent did not report it.
 */
export function gigabytes(mb: number | null): string {
  if (!mb || mb <= 0) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${Math.round(mb / 1024)} GB`;
}
