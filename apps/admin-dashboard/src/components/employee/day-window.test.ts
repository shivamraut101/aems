import { describe, expect, it } from "vitest";

import { isoDate, resolveDay, shiftDay } from "./day-window";

/** Local midnight, so the assertions do not depend on the machine's timezone. */
function localMidnight(iso: string): boolean {
  const date = new Date(iso);
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
}

describe("isoDate", () => {
  it("formats a local calendar date, not a UTC one", () => {
    // 23:30 local on the 5th is the 6th in UTC east of Greenwich. The day a manager
    // asked for is the one on their own calendar.
    expect(isoDate(new Date(2026, 7, 5, 23, 30))).toBe("2026-08-05");
    expect(isoDate(new Date(2026, 0, 9, 0, 5))).toBe("2026-01-09");
  });
});

describe("shiftDay", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("is a no-op for zero", () => {
    expect(shiftDay("2026-08-05", 0)).toBe("2026-08-05");
  });
});

describe("resolveDay", () => {
  const now = new Date(2026, 7, 5, 14, 30);

  it("defaults to today when the query string says nothing", () => {
    const day = resolveDay(null, now);

    expect(day.date).toBe("2026-08-05");
    expect(day.isToday).toBe(true);
  });

  it("offers no next day from today — there is no future to look at", () => {
    expect(resolveDay(null, now).next).toBeNull();
    expect(resolveDay("2026-08-04", now).next).toBe("2026-08-05");
  });

  it("always offers the previous day", () => {
    expect(resolveDay("2026-08-05", now).previous).toBe("2026-08-04");
    expect(resolveDay("2026-01-01", now).previous).toBe("2025-12-31");
  });

  it("spans one whole local day, midnight to midnight", () => {
    const day = resolveDay("2026-08-04", now);

    expect(localMidnight(day.from)).toBe(true);
    expect(localMidnight(day.to)).toBe(true);
    expect(Date.parse(day.to)).toBeGreaterThan(Date.parse(day.from));
    expect(isoDate(new Date(day.from))).toBe("2026-08-04");
    expect(isoDate(new Date(day.to))).toBe("2026-08-05");
  });

  it("sends the API an instant with an offset, which is what it validates", () => {
    const day = resolveDay("2026-08-04", now);

    expect(day.from).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    expect(day.to).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
  });

  it("falls back to today rather than 404ing on a hand-edited URL", () => {
    expect(resolveDay("not-a-date", now).date).toBe("2026-08-05");
    expect(resolveDay("2026-13-45", now).date).toBe("2026-08-05");
    expect(resolveDay("2026-02-30", now).date).toBe("2026-08-05");
    expect(resolveDay("", now).date).toBe("2026-08-05");
  });

  it("clamps a future date to today instead of showing an empty tomorrow", () => {
    expect(resolveDay("2026-09-01", now).date).toBe("2026-08-05");
    expect(resolveDay("2026-09-01", now).isToday).toBe(true);
  });

  it("labels the day in words, because a bare ISO date is not a reading experience", () => {
    expect(resolveDay("2026-08-04", now).label.length).toBeGreaterThan(0);
    expect(resolveDay("2026-08-04", now).label).not.toBe("2026-08-04");
  });
});
