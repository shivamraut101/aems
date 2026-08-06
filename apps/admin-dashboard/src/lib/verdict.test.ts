import { describe, expect, it } from "vitest";

import type { LiveWorkforceRow, OverviewMetrics } from "@/lib/api";
import { STALE_AFTER_HOURS, computeVerdict, verdictAllClear } from "./verdict";

/**
 * The verdict points a manager at one named employee, so being wrong here is not a
 * cosmetic failure — it is telling someone to go and ask a colleague why they have
 * stopped working when they have not.
 */

const NOW = Date.parse("2026-08-06T17:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const METRICS: OverviewMetrics = {
  totalEmployees: 4,
  activeNow: 1,
  workingToday: 2,
  totalHoursToday: 14.7,
};

function row(over: Partial<LiveWorkforceRow> = {}): LiveWorkforceRow {
  return {
    deviceId: "d1",
    platform: "windows",
    label: "Laptop",
    profileId: "p1",
    fullName: "Evan Employee",
    email: "evan@aems.local",
    lastSeenAt: hoursAgo(1),
    idleSince: null,
    status: "active",
    ...over,
  };
}

describe("computeVerdict", () => {
  it("is null until the metrics arrive", () => {
    // Not a zero verdict. "0 of 0 working" is a statement about the business, and an
    // unanswered query must never be allowed to make it.
    expect(computeVerdict(undefined, [], NOW)).toBeNull();
  });

  it("counts working out of total", () => {
    const v = computeVerdict(METRICS, [row()], NOW)!;
    expect(v.working).toBe(2);
    expect(v.total).toBe(4);
  });

  it("names an enrolled device that has gone quiet", () => {
    const v = computeVerdict(
      METRICS,
      [row(), row({ profileId: "p2", fullName: "Marcus Manager", status: "offline", lastSeenAt: hoursAgo(48) })],
      NOW,
    )!;
    expect(v.attention?.name).toBe("Marcus Manager");
    expect(v.attention?.reason).toContain("not reported");
  });

  it("prefers a silent device over an unenrolled person", () => {
    // The ranking is the point: one may mean something is broken, the other is a
    // setup task. Surfacing the setup task first buries the incident.
    const v = computeVerdict(
      METRICS,
      [
        row({ profileId: "p3", fullName: "Ada Admin", deviceId: null, lastSeenAt: null }),
        row({ profileId: "p2", fullName: "Marcus Manager", status: "offline", lastSeenAt: hoursAgo(48) }),
      ],
      NOW,
    )!;
    expect(v.attention?.name).toBe("Marcus Manager");
  });

  it("says nothing about someone merely offline at the end of their day", () => {
    const v = computeVerdict(METRICS, [row({ status: "offline", lastSeenAt: hoursAgo(3) })], NOW)!;
    expect(v.attention).toBeNull();
  });

  it("holds its tongue right up to the threshold", () => {
    const just = computeVerdict(
      METRICS,
      [row({ status: "offline", lastSeenAt: hoursAgo(STALE_AFTER_HOURS - 0.5) })],
      NOW,
    )!;
    expect(just.attention).toBeNull();

    const past = computeVerdict(
      METRICS,
      [row({ status: "offline", lastSeenAt: hoursAgo(STALE_AFTER_HOURS + 0.5) })],
      NOW,
    )!;
    expect(past.attention).not.toBeNull();
  });

  it("counts the others rather than listing them", () => {
    const v = computeVerdict(
      METRICS,
      [
        row({ profileId: "a", fullName: "Ada", deviceId: null, lastSeenAt: null }),
        row({ profileId: "b", fullName: "Bo", deviceId: null, lastSeenAt: null }),
        row({ profileId: "c", fullName: "Cy", deviceId: null, lastSeenAt: null }),
      ],
      NOW,
    )!;
    expect(v.attention?.reason).toContain("2 others");
  });

  it("falls back to the email when a profile has no name", () => {
    const v = computeVerdict(
      METRICS,
      [row({ fullName: null, deviceId: null, lastSeenAt: null })],
      NOW,
    )!;
    // Never an empty string beside "has no device enrolled yet".
    expect(v.attention?.name).toBe("evan@aems.local");
  });
});

describe("verdictAllClear", () => {
  it("is true only when nobody needs attention and someone is working", () => {
    expect(verdictAllClear({ working: 2, total: 4, attention: null })).toBe(true);
    expect(verdictAllClear({ working: 0, total: 4, attention: null })).toBe(false);
    expect(
      verdictAllClear({ working: 2, total: 4, attention: { profileId: "x", name: "X", reason: "r" } }),
    ).toBe(false);
  });
});
