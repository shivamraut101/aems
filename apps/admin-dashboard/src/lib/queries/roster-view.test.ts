import { describe, expect, it } from "vitest";

import type { DeviceRow, EmployeeRow } from "@/lib/api";

import {
  compareLastSeen,
  departmentOptions,
  deviceFilterParams,
  deviceLastSeen,
  gigabytes,
  matchesDeviceFilter,
  matchesPeopleFilter,
  monitoringSummary,
  parseDeviceFilters,
  parsePeopleFilters,
  peopleFilterParams,
  peopleLastSeen,
  platformOptions,
} from "./roster-view";

function person(overrides: Partial<EmployeeRow> = {}): EmployeeRow {
  return {
    id: "p1",
    email: "ada@example.com",
    full_name: "Ada Lovelace",
    role: "employee",
    department: "Engineering",
    manager_id: null,
    monitoring_enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    devices: [],
    ...overrides,
  };
}

function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: "d1",
    profile_id: "p1",
    platform: "windows",
    label: "Ada laptop",
    device_name: "ADA-WIN-01",
    os_version: "11",
    agent_version: "0.1.0",
    model: "ThinkPad X1",
    cpu: "Intel i7",
    ram_mb: 16384,
    storage_mb: 512000,
    status: "active",
    last_seen_at: "2026-08-05T09:00:00.000Z",
    enrolled_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchesPeopleFilter", () => {
  const empty = { search: "", department: null, monitoring: "all" } as const;

  it("keeps everyone when nothing is filtered", () => {
    expect(matchesPeopleFilter(person(), empty)).toBe(true);
  });

  it("matches name, email and department, case-insensitively", () => {
    expect(matchesPeopleFilter(person(), { ...empty, search: "LOVELACE" })).toBe(true);
    expect(matchesPeopleFilter(person(), { ...empty, search: "ada@" })).toBe(true);
    expect(matchesPeopleFilter(person(), { ...empty, search: "engineer" })).toBe(true);
    expect(matchesPeopleFilter(person(), { ...empty, search: "grace" })).toBe(false);
  });

  it("ignores surrounding whitespace in the search box", () => {
    expect(matchesPeopleFilter(person(), { ...empty, search: "  ada  " })).toBe(true);
  });

  it("matches a person with no name by their email", () => {
    const row = person({ full_name: "", department: null });
    expect(matchesPeopleFilter(row, { ...empty, search: "ada" })).toBe(true);
  });

  it("filters by department exactly, so 'Design' does not match 'Design Ops'", () => {
    expect(matchesPeopleFilter(person(), { ...empty, department: "Engineering" })).toBe(true);
    expect(matchesPeopleFilter(person(), { ...empty, department: "Design" })).toBe(false);
    expect(
      matchesPeopleFilter(person({ department: "Design Ops" }), { ...empty, department: "Design" }),
    ).toBe(false);
  });

  it("offers an explicit bucket for people with no department", () => {
    expect(matchesPeopleFilter(person({ department: null }), { ...empty, department: "—" })).toBe(
      true,
    );
    expect(matchesPeopleFilter(person(), { ...empty, department: "—" })).toBe(false);
  });

  it("filters on the monitoring toggle", () => {
    expect(matchesPeopleFilter(person(), { ...empty, monitoring: "on" })).toBe(true);
    expect(matchesPeopleFilter(person(), { ...empty, monitoring: "paused" })).toBe(false);
    const paused = person({ monitoring_enabled: false });
    expect(matchesPeopleFilter(paused, { ...empty, monitoring: "paused" })).toBe(true);
    expect(matchesPeopleFilter(paused, { ...empty, monitoring: "on" })).toBe(false);
  });

  it("ANDs the three filters together", () => {
    expect(
      matchesPeopleFilter(person(), { search: "ada", department: "Design", monitoring: "all" }),
    ).toBe(false);
  });
});

describe("departmentOptions", () => {
  it("lists each department once, sorted, with a bucket for the unassigned", () => {
    const rows = [
      person({ id: "1", department: "Support" }),
      person({ id: "2", department: "Engineering" }),
      person({ id: "3", department: "Engineering" }),
      person({ id: "4", department: null }),
    ];
    expect(departmentOptions(rows)).toEqual(["Engineering", "Support", "—"]);
  });

  it("does not offer the unassigned bucket when everyone has a department", () => {
    expect(departmentOptions([person()])).toEqual(["Engineering"]);
  });

  it("treats a blank department as unassigned rather than as an empty option", () => {
    expect(departmentOptions([person({ department: "   " })])).toEqual(["—"]);
  });

  it("survives an empty roster", () => {
    expect(departmentOptions([])).toEqual([]);
  });
});

describe("peopleLastSeen", () => {
  it("reports the newest heartbeat across a person's devices", () => {
    const row = person({
      devices: [
        { id: "a", platform: "windows", label: "L", status: "active", last_seen_at: "2026-08-05T09:00:00.000Z" },
        { id: "b", platform: "android", label: "P", status: "active", last_seen_at: "2026-08-05T11:30:00.000Z" },
        { id: "c", platform: "macos", label: "M", status: "offline", last_seen_at: null },
      ],
    });
    expect(peopleLastSeen(row)).toBe("2026-08-05T11:30:00.000Z");
  });

  it("compares instants, not strings — a mixed-offset timestamp still sorts correctly", () => {
    const row = person({
      devices: [
        { id: "a", platform: "windows", label: "L", status: "active", last_seen_at: "2026-08-05T11:00:00.000Z" },
        { id: "b", platform: "macos", label: "M", status: "active", last_seen_at: "2026-08-05T14:00:00+02:00" },
      ],
    });
    // 14:00+02:00 is 12:00Z — later than 11:00Z, though it sorts earlier as text.
    expect(peopleLastSeen(row)).toBe("2026-08-05T14:00:00+02:00");
  });

  it("is null for someone with no devices, and for devices that never reported", () => {
    expect(peopleLastSeen(person())).toBeNull();
    expect(
      peopleLastSeen(
        person({
          devices: [{ id: "a", platform: "windows", label: "L", status: "offline", last_seen_at: null }],
        }),
      ),
    ).toBeNull();
  });
});

describe("compareLastSeen", () => {
  it("sorts older before newer", () => {
    expect(
      compareLastSeen("2026-08-05T09:00:00.000Z", "2026-08-05T11:00:00.000Z"),
    ).toBeLessThan(0);
  });

  it("puts a device that never reported at the bottom of an ascending sort", () => {
    expect(compareLastSeen(null, "2026-08-05T09:00:00.000Z")).toBeLessThan(0);
    expect(compareLastSeen("2026-08-05T09:00:00.000Z", null)).toBeGreaterThan(0);
    expect(compareLastSeen(null, null)).toBe(0);
  });

  it("treats an unparseable timestamp as never rather than as NaN", () => {
    expect(compareLastSeen("not a date", "2026-08-05T09:00:00.000Z")).toBeLessThan(0);
  });
});

describe("monitoringSummary", () => {
  it("counts who is being monitored and who is paused", () => {
    const rows = [
      person({ id: "1" }),
      person({ id: "2", monitoring_enabled: false }),
      person({ id: "3" }),
    ];
    expect(monitoringSummary(rows)).toEqual({ total: 3, enabled: 2, paused: 1 });
  });

  it("is all zeroes for an empty roster rather than undefined", () => {
    expect(monitoringSummary([])).toEqual({ total: 0, enabled: 0, paused: 0 });
  });
});

describe("matchesDeviceFilter", () => {
  const empty = { search: "", platform: null, status: null } as const;

  it("matches device name, label, model and OS", () => {
    expect(matchesDeviceFilter(device(), { ...empty, search: "ADA-WIN" })).toBe(true);
    expect(matchesDeviceFilter(device(), { ...empty, search: "thinkpad" })).toBe(true);
    expect(matchesDeviceFilter(device(), { ...empty, search: "laptop" })).toBe(true);
    expect(matchesDeviceFilter(device(), { ...empty, search: "pixel" })).toBe(false);
  });

  it("filters by platform and status", () => {
    expect(matchesDeviceFilter(device(), { ...empty, platform: "windows" })).toBe(true);
    expect(matchesDeviceFilter(device(), { ...empty, platform: "macos" })).toBe(false);
    expect(matchesDeviceFilter(device(), { ...empty, status: "active" })).toBe(true);
    expect(matchesDeviceFilter(device({ status: "revoked" }), { ...empty, status: "active" })).toBe(
      false,
    );
  });

  it("survives a device with no model and no CPU", () => {
    const bare = device({ model: null, cpu: null });
    expect(matchesDeviceFilter(bare, { ...empty, search: "ada-win" })).toBe(true);
    expect(matchesDeviceFilter(bare, { ...empty, search: "thinkpad" })).toBe(false);
  });
});

describe("platformOptions", () => {
  it("offers only the platforms actually enrolled, in a fixed order", () => {
    const rows = [
      device({ id: "1", platform: "android" }),
      device({ id: "2", platform: "windows" }),
      device({ id: "3", platform: "windows" }),
    ];
    expect(platformOptions(rows)).toEqual(["windows", "android"]);
  });

  it("is empty when nothing is enrolled", () => {
    expect(platformOptions([])).toEqual([]);
  });
});

describe("deviceLastSeen", () => {
  it("passes the device's own heartbeat through", () => {
    expect(deviceLastSeen(device())).toBe("2026-08-05T09:00:00.000Z");
    expect(deviceLastSeen(device({ last_seen_at: null }))).toBeNull();
  });
});

describe("parsePeopleFilters", () => {
  it("reads all three controls out of the query", () => {
    expect(parsePeopleFilters({ q: "ada", dept: "Design", monitoring: "paused" })).toEqual({
      search: "ada",
      department: "Design",
      monitoring: "paused",
    });
  });

  it("is the empty filter set when the query says nothing", () => {
    expect(parsePeopleFilters({})).toEqual({ search: "", department: null, monitoring: "all" });
  });

  it("ignores a monitoring value it does not recognise instead of showing nobody", () => {
    expect(parsePeopleFilters({ monitoring: "sometimes" }).monitoring).toBe("all");
  });

  it("trims the search term, so a trailing space is not a different URL", () => {
    expect(parsePeopleFilters({ q: "  ada " }).search).toBe("ada");
  });

  it("treats a blank department parameter as no department filter", () => {
    expect(parsePeopleFilters({ dept: "" }).department).toBeNull();
  });
});

describe("peopleFilterParams", () => {
  it("omits every control that is not set, so a clean view has a clean URL", () => {
    expect(peopleFilterParams({ search: "", department: null, monitoring: "all" })).toEqual({
      q: null,
      dept: null,
      monitoring: null,
    });
  });

  it("round-trips a fully specified filter set", () => {
    const filters = { search: "ada", department: "—", monitoring: "on" } as const;
    expect(parsePeopleFilters(peopleFilterParams(filters) as Record<string, string>)).toEqual(
      filters,
    );
  });
});

describe("parseDeviceFilters / deviceFilterParams", () => {
  it("reads platform and status out of the query", () => {
    expect(parseDeviceFilters({ q: "ada", platform: "macos", status: "revoked" })).toEqual({
      search: "ada",
      platform: "macos",
      status: "revoked",
    });
  });

  it("drops a platform or status outside the enum rather than filtering to nothing", () => {
    expect(parseDeviceFilters({ platform: "linux", status: "asleep" })).toEqual({
      search: "",
      platform: null,
      status: null,
    });
  });

  it("round-trips", () => {
    const filters = { search: "thinkpad", platform: "windows", status: "active" } as const;
    expect(parseDeviceFilters(deviceFilterParams(filters) as Record<string, string>)).toEqual(
      filters,
    );
  });

  it("clears every parameter for the empty filter set", () => {
    expect(deviceFilterParams({ search: "", platform: null, status: null })).toEqual({
      q: null,
      platform: null,
      status: null,
    });
  });
});

describe("gigabytes", () => {
  it("renders megabytes as whole gigabytes", () => {
    expect(gigabytes(16384)).toBe("16 GB");
    expect(gigabytes(8192)).toBe("8 GB");
  });

  it("renders an em dash for unknown, and for zero, rather than '0 GB'", () => {
    expect(gigabytes(null)).toBe("—");
    expect(gigabytes(0)).toBe("—");
  });

  it("keeps a sub-gigabyte value legible instead of rounding it to 0 GB", () => {
    expect(gigabytes(512)).toBe("512 MB");
  });
});
