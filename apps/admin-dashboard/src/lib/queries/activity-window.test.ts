import { describe, expect, it } from "vitest";

import { DEFAULT_SLOT_SECONDS, alignedDayWindow, dateKeyOf, dayWindow } from "./activity";

/**
 * The regression these cover: the Activity screen re-derived its window from a
 * millisecond-precise `now` every sixty seconds, which minted a new TanStack query
 * key every sixty seconds, which replaced the selected person's timeline with a
 * skeleton every sixty seconds.
 *
 * A separate file from `activity.test.ts` so the two can be merged without a
 * conflict; the subject is the same module.
 *
 * Nothing below assumes the runner's timezone offset is a whole number of slots —
 * `Asia/Kathmandu` is +05:45, so local midnight is not always on the ten-minute grid
 * and a test anchored to it would pass in Delhi and fail in Kathmandu.
 */

const SLOT_MS = DEFAULT_SLOT_SECONDS * 1000;

/** Local midnight of a day key — what both window functions anchor `from` to. */
function localMidnight(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 0, 0, 0, 0).getTime();
}

/** A mid-morning instant that sits exactly on a slot boundary, in any timezone. */
function slotBoundaryMorning(key: string): number {
  return Math.floor((localMidnight(key) + 9 * 3600_000) / SLOT_MS) * SLOT_MS;
}

const DAY = "2026-08-05";

describe("alignedDayWindow", () => {
  it("starts at local midnight of the day it is given", () => {
    const window = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, new Date(slotBoundaryMorning(DAY)));
    expect(window.from).toBe(new Date(localMidnight(DAY)).toISOString());
  });

  it("ends on a slot boundary", () => {
    const now = new Date(slotBoundaryMorning(DAY) + 337_123);
    const { to } = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, now);

    expect(Date.parse(to) % SLOT_MS).toBe(0);
  });

  it("returns the identical window for every instant inside one slot", () => {
    const base = slotBoundaryMorning(DAY);

    const early = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, new Date(base + 1));
    const late = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, new Date(base + SLOT_MS - 1));

    expect(early).toEqual(late);
  });

  it("advances by exactly one slot when the clock crosses a boundary", () => {
    const base = slotBoundaryMorning(DAY);

    const before = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, new Date(base + SLOT_MS - 1));
    const after = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, new Date(base + SLOT_MS + 1));

    expect(Date.parse(after.to) - Date.parse(before.to)).toBe(SLOT_MS);
  });

  it("produces ~144 keys across a day where the old window produced ~1440", () => {
    const midnight = localMidnight(DAY);
    const aligned = new Set<string>();
    const unrounded = new Set<string>();

    // Sampled once a minute, exactly as the screen's own interval does.
    for (let minute = 0; minute < 1440; minute += 1) {
      const now = new Date(midnight + minute * 60_000);
      aligned.add(alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, now).to);
      unrounded.add(dayWindow(DAY, now).to);
    }

    // 144 slots in a day; 145 only where local midnight is off-grid and the last
    // window is clamped to the end of the day.
    expect(aligned.size).toBeLessThanOrEqual(145);
    expect(aligned.size).toBeGreaterThanOrEqual(144);
    expect(unrounded.size).toBeGreaterThan(1400);
  });

  it("never runs past the end of the day it was asked for", () => {
    const dayEnd = localMidnight("2026-08-06");

    // A day already over: `now` is a week later.
    const { to } = alignedDayWindow(DAY, DEFAULT_SLOT_SECONDS, new Date(dayEnd + 7 * 86_400_000));
    expect(Date.parse(to)).toBe(dayEnd);
  });

  it("asks a well-formed question about a day that has not happened", () => {
    // `to <= from` is a 400 from the API, so a future day must still get a window.
    const future = "2027-01-01";
    const { from, to } = alignedDayWindow(future, DEFAULT_SLOT_SECONDS, new Date(localMidnight(DAY)));

    expect(Date.parse(to)).toBeGreaterThan(Date.parse(from));
    expect(Date.parse(to) - Date.parse(from)).toBe(SLOT_MS);
  });

  it("honours a slot width other than the default", () => {
    const now = new Date(Math.floor((localMidnight(DAY) + 9 * 3600_000) / 300_000) * 300_000 + 61_000);

    const { to } = alignedDayWindow(DAY, 300, now);
    expect(Date.parse(to) % 300_000).toBe(0);
  });

  it("keeps the window on the day the key names, not the day `now` falls in", () => {
    const yesterday = "2026-08-04";
    const { from, to } = alignedDayWindow(
      yesterday,
      DEFAULT_SLOT_SECONDS,
      new Date(slotBoundaryMorning(DAY)),
    );

    expect(dateKeyOf(new Date(from))).toBe(yesterday);
    expect(Date.parse(to)).toBe(localMidnight(DAY));
  });
});
