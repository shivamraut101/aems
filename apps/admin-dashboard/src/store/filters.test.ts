import { describe, expect, it } from "vitest";

import {
  applyRangeToQuery,
  canShiftForward,
  mergeQuery,
  parseRangeSelection,
  rangeLabel,
  rangeSearchParams,
  resolveRange,
  shiftRange,
  useFilters,
  type RangeSelection,
} from "./filters";

/**
 * Every expectation is built from local `Date` components rather than a literal ISO
 * string, so the suite passes in IST, UTC and PST alike. A day boundary is a local
 * midnight — that is what a person means by "yesterday" — and hardcoding "T00:00:00Z"
 * would only prove the test author's timezone.
 */
const localMidnight = (year: number, monthIndex: number, day: number): string =>
  new Date(year, monthIndex, day).toISOString();

// Wednesday 5 August 2026, 14:30 local.
const NOW = new Date(2026, 7, 5, 14, 30, 0);

describe("resolveRange", () => {
  it("resolves today to local midnight through the end of today", () => {
    expect(resolveRange({ kind: "preset", preset: "today" }, NOW)).toEqual({
      from: localMidnight(2026, 7, 5),
      to: localMidnight(2026, 7, 6),
    });
  });

  it("ends a window at the next midnight, not at `now`, so the query key is stable", () => {
    const early = resolveRange({ kind: "preset", preset: "today" }, new Date(2026, 7, 5, 9, 0, 0));
    const late = resolveRange({ kind: "preset", preset: "today" }, new Date(2026, 7, 5, 17, 45, 0));
    expect(early).toEqual(late);
  });

  it("resolves yesterday to that single day", () => {
    expect(resolveRange({ kind: "preset", preset: "yesterday" }, NOW)).toEqual({
      from: localMidnight(2026, 7, 4),
      to: localMidnight(2026, 7, 5),
    });
  });

  it("counts the last 7 days inclusive of today", () => {
    expect(resolveRange({ kind: "preset", preset: "7d" }, NOW)).toEqual({
      from: localMidnight(2026, 6, 30),
      to: localMidnight(2026, 7, 6),
    });
  });

  it("counts the last 30 days inclusive of today", () => {
    expect(resolveRange({ kind: "preset", preset: "30d" }, NOW)).toEqual({
      from: localMidnight(2026, 6, 7),
      to: localMidnight(2026, 7, 6),
    });
  });

  it("includes the whole of an absolute end day", () => {
    const selection: RangeSelection = { kind: "absolute", from: "2026-08-01", to: "2026-08-03" };
    expect(resolveRange(selection, NOW)).toEqual({
      from: localMidnight(2026, 7, 1),
      to: localMidnight(2026, 7, 4),
    });
  });

  it("still accepts a bare preset, the shape the store used to hold", () => {
    expect(resolveRange("yesterday", NOW)).toEqual({
      from: localMidnight(2026, 7, 4),
      to: localMidnight(2026, 7, 5),
    });
  });
});

describe("parseRangeSelection", () => {
  it("reads a known preset out of the query", () => {
    expect(parseRangeSelection({ range: "7d" })).toEqual({ kind: "preset", preset: "7d" });
  });

  it("reads an absolute window", () => {
    expect(parseRangeSelection({ range: "custom", from: "2026-08-01", to: "2026-08-03" })).toEqual({
      kind: "absolute",
      from: "2026-08-01",
      to: "2026-08-03",
    });
  });

  it("accepts from/to without the range marker, because a shared link may be hand-edited", () => {
    expect(parseRangeSelection({ from: "2026-08-01", to: "2026-08-03" })).toEqual({
      kind: "absolute",
      from: "2026-08-01",
      to: "2026-08-03",
    });
  });

  it("orders a backwards window rather than resolving to a negative range", () => {
    expect(parseRangeSelection({ from: "2026-08-03", to: "2026-08-01" })).toEqual({
      kind: "absolute",
      from: "2026-08-01",
      to: "2026-08-03",
    });
  });

  it("falls back to the default when the query says nothing", () => {
    expect(parseRangeSelection({})).toEqual({ kind: "preset", preset: "today" });
    expect(parseRangeSelection({}, "30d")).toEqual({ kind: "preset", preset: "30d" });
  });

  it("falls back rather than trusting an unparseable date", () => {
    expect(parseRangeSelection({ range: "custom", from: "yesterday", to: "2026-08-03" })).toEqual({
      kind: "preset",
      preset: "today",
    });
    expect(parseRangeSelection({ range: "custom", from: "2026-13-45", to: "2026-08-03" })).toEqual({
      kind: "preset",
      preset: "today",
    });
    expect(parseRangeSelection({ range: "last-week" })).toEqual({ kind: "preset", preset: "today" });
  });

  it("needs both ends before it will believe an absolute window", () => {
    expect(parseRangeSelection({ range: "custom", from: "2026-08-01" })).toEqual({
      kind: "preset",
      preset: "today",
    });
  });
});

describe("rangeSearchParams", () => {
  it("writes a preset as one parameter", () => {
    expect(rangeSearchParams({ kind: "preset", preset: "7d" })).toEqual({ range: "7d" });
  });

  it("writes an absolute window as three", () => {
    expect(rangeSearchParams({ kind: "absolute", from: "2026-08-01", to: "2026-08-03" })).toEqual({
      range: "custom",
      from: "2026-08-01",
      to: "2026-08-03",
    });
  });

  it("round-trips through parseRangeSelection", () => {
    const selections: RangeSelection[] = [
      { kind: "preset", preset: "today" },
      { kind: "preset", preset: "30d" },
      { kind: "absolute", from: "2026-01-09", to: "2026-02-11" },
    ];
    for (const selection of selections) {
      expect(parseRangeSelection(rangeSearchParams(selection))).toEqual(selection);
    }
  });
});

describe("applyRangeToQuery", () => {
  it("keeps every other parameter, so a selection does not drop the person being viewed", () => {
    expect(applyRangeToQuery("profileId=abc&range=30d", { kind: "preset", preset: "today" })).toBe(
      "profileId=abc&range=today",
    );
  });

  it("clears from/to when switching back to a preset", () => {
    expect(
      applyRangeToQuery("range=custom&from=2026-08-01&to=2026-08-03", {
        kind: "preset",
        preset: "7d",
      }),
    ).toBe("range=7d");
  });

  it("accepts a leading ? and returns a query string without one", () => {
    expect(
      applyRangeToQuery("?tab=apps", { kind: "absolute", from: "2026-08-01", to: "2026-08-03" }),
    ).toBe("tab=apps&range=custom&from=2026-08-01&to=2026-08-03");
  });
});

describe("mergeQuery", () => {
  it("sets a value and leaves the rest of the query alone", () => {
    expect(mergeQuery("range=today&profileId=abc", { q: "ada" })).toBe(
      "range=today&profileId=abc&q=ada",
    );
  });

  it("removes a parameter when the value is null or empty", () => {
    expect(mergeQuery("q=ada&dept=Design", { q: null })).toBe("dept=Design");
    expect(mergeQuery("q=ada&dept=Design", { dept: "" })).toBe("q=ada");
  });

  it("updates in place rather than appending a second copy", () => {
    expect(mergeQuery("q=ada&dept=Design", { q: "grace" })).toBe("q=grace&dept=Design");
  });

  it("returns an empty string when the last parameter is cleared", () => {
    expect(mergeQuery("q=ada", { q: null })).toBe("");
  });

  it("escapes values rather than pasting them into the URL raw", () => {
    expect(mergeQuery("", { q: "a&b=c d" })).toBe("q=a%26b%3Dc+d");
  });
});

describe("shiftRange", () => {
  it("steps a single day back one day", () => {
    expect(shiftRange({ kind: "preset", preset: "today" }, -1, NOW)).toEqual({
      kind: "absolute",
      from: "2026-08-04",
      to: "2026-08-04",
    });
  });

  it("steps a window back by its own length", () => {
    expect(shiftRange({ kind: "preset", preset: "7d" }, -1, NOW)).toEqual({
      kind: "absolute",
      from: "2026-07-23",
      to: "2026-07-29",
    });
  });

  it("steps forward by the same length", () => {
    expect(
      shiftRange({ kind: "absolute", from: "2026-07-23", to: "2026-07-29" }, 1, NOW),
    ).toEqual({ kind: "absolute", from: "2026-07-30", to: "2026-08-05" });
  });

  it("crosses a month boundary without producing a 32nd day", () => {
    expect(
      shiftRange({ kind: "absolute", from: "2026-08-01", to: "2026-08-01" }, -1, NOW),
    ).toEqual({ kind: "absolute", from: "2026-07-31", to: "2026-07-31" });
  });

  it("never steps past today — there is no data in the future", () => {
    expect(shiftRange({ kind: "preset", preset: "today" }, 1, NOW)).toEqual({
      kind: "preset",
      preset: "today",
    });
  });
});

describe("canShiftForward", () => {
  it("is false while the window already ends today", () => {
    expect(canShiftForward({ kind: "preset", preset: "today" }, NOW)).toBe(false);
    expect(canShiftForward({ kind: "preset", preset: "7d" }, NOW)).toBe(false);
    expect(canShiftForward({ kind: "absolute", from: "2026-08-05", to: "2026-08-05" }, NOW)).toBe(
      false,
    );
  });

  it("is true for a window that ended before today", () => {
    expect(canShiftForward({ kind: "preset", preset: "yesterday" }, NOW)).toBe(true);
    expect(canShiftForward({ kind: "absolute", from: "2026-07-01", to: "2026-07-31" }, NOW)).toBe(
      true,
    );
  });
});

describe("rangeLabel", () => {
  it("names the presets", () => {
    expect(rangeLabel({ kind: "preset", preset: "today" }, NOW)).toBe("Today");
    expect(rangeLabel({ kind: "preset", preset: "yesterday" }, NOW)).toBe("Yesterday");
    expect(rangeLabel({ kind: "preset", preset: "7d" }, NOW)).toBe("Last 7 days");
    expect(rangeLabel({ kind: "preset", preset: "30d" }, NOW)).toBe("Last 30 days");
  });

  it("says Today for an absolute window that happens to be today", () => {
    expect(rangeLabel({ kind: "absolute", from: "2026-08-05", to: "2026-08-05" }, NOW)).toBe(
      "Today",
    );
    expect(rangeLabel({ kind: "absolute", from: "2026-08-04", to: "2026-08-04" }, NOW)).toBe(
      "Yesterday",
    );
  });

  it("formats a one-off day", () => {
    expect(rangeLabel({ kind: "absolute", from: "2026-07-09", to: "2026-07-09" }, NOW)).toBe(
      "9 Jul 2026",
    );
  });

  it("drops the repeated year from a same-year window", () => {
    expect(rangeLabel({ kind: "absolute", from: "2026-07-09", to: "2026-08-03" }, NOW)).toBe(
      "9 Jul – 3 Aug 2026",
    );
  });

  it("keeps both years when the window crosses one", () => {
    expect(rangeLabel({ kind: "absolute", from: "2025-12-30", to: "2026-01-02" }, NOW)).toBe(
      "30 Dec 2025 – 2 Jan 2026",
    );
  });
});

describe("useFilters", () => {
  it("holds only client-only preferences — no server data is mirrored here", () => {
    const state = useFilters.getState();
    expect(state.defaultRange).toBe("today");
    expect(Object.keys(state).sort()).toEqual(
      ["columnVisibility", "defaultRange", "setColumnVisibility", "setDefaultRange"].sort(),
    );
  });

  it("remembers a preferred default range", () => {
    useFilters.getState().setDefaultRange("7d");
    expect(useFilters.getState().defaultRange).toBe("7d");
    useFilters.getState().setDefaultRange("today");
  });

  it("remembers column visibility per table without disturbing the other table", () => {
    useFilters.getState().setColumnVisibility("people", { department: false });
    useFilters.getState().setColumnVisibility("devices", { cpu: false });

    expect(useFilters.getState().columnVisibility["people"]).toEqual({ department: false });
    expect(useFilters.getState().columnVisibility["devices"]).toEqual({ cpu: false });
  });
});
