import { describe, expect, it } from "vitest";

import {
  buildReviewRows,
  dayWindow,
  describeBlockActivity,
  durationWords,
  flattenCaptures,
  noteImageFailure,
  resignAfterMs,
  stepCapture,
  type ScreenshotBlock,
  type ScreenshotCapture,
  type TimelineSlotView,
} from "./screenshots";

/** Minutes past 09:00 UTC on the fixed test day. */
function at(minute: number, second = 0): string {
  return new Date(
    Date.parse("2026-08-05T09:00:00.000Z") + minute * 60_000 + second * 1000,
  ).toISOString();
}

/** Deterministic clock label, so the tests do not assert the runner's locale. */
const hhmm = (iso: string) => iso.slice(11, 16);

let nextId = 1;

function capture(capturedAt: string, overrides: Partial<ScreenshotCapture> = {}): ScreenshotCapture {
  const id = overrides.id ?? nextId++;
  return {
    id,
    capturedAt,
    url: `https://signed.example/full/${id}`,
    thumbnailUrl: `https://signed.example/thumb/${id}`,
    blurred: false,
    workSessionId: null,
    ...overrides,
  };
}

function block(startMinute: number, captures: ScreenshotCapture[] = []): ScreenshotBlock {
  return {
    periodStart: at(startMinute),
    periodEnd: at(startMinute + 10),
    screenshots: captures,
    screenshotCount: captures.length,
    monitorCount: captures.length === 0 ? 0 : 1,
  };
}

function slot(startMinute: number, overrides: Partial<TimelineSlotView> = {}): TimelineSlotView {
  return {
    start: at(startMinute),
    end: at(startMinute + 10),
    activeSeconds: 600,
    idleSeconds: 0,
    breakSeconds: 0,
    offlineSeconds: 0,
    activityRatio: 1,
    topApps: [{ appName: "Code", category: "Work > Development", seconds: 600 }],
    screenshots: [],
    ...overrides,
  };
}

describe("dayWindow", () => {
  it("spans one whole local day for a day that has already finished", () => {
    const { from, to } = dayWindow("2026-08-05", new Date("2026-08-09T10:00:00"));

    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(from).getDate()).toBe(5);
    expect(new Date(to).getDate()).toBe(6);
    expect(new Date(to).getHours()).toBe(0);
  });

  it("stops at the current block instead of rendering the rest of the day as empty", () => {
    // A day in progress has no captures after "now". Fourteen hours of "No capture"
    // rows would read as a fault rather than as a day that has not happened yet.
    const now = new Date("2026-08-05T11:07:00");
    const { to } = dayWindow("2026-08-05", now);

    expect(Date.parse(to)).toBeGreaterThanOrEqual(now.getTime());
    expect(Date.parse(to) - now.getTime()).toBeLessThan(600_000);
    expect(Date.parse(to) % 600_000).toBe(0);
  });

  it("never produces a window the API would refuse as invalid_range", () => {
    // `to <= from` is a 400 on /api/screenshots/blocks. A future date must still
    // ask a well-formed question and get an empty answer back.
    const { from, to } = dayWindow("2026-09-01", new Date("2026-08-05T11:07:00"));

    expect(Date.parse(to)).toBeGreaterThan(Date.parse(from));
  });
});

describe("durationWords", () => {
  it("keeps seconds visible at the ten-minute block scale", () => {
    expect(durationWords(450)).toBe("7m 30s");
    expect(durationWords(45)).toBe("45s");
  });

  it("drops the empty tail rather than padding with a zero", () => {
    expect(durationWords(420)).toBe("7m");
    expect(durationWords(3600)).toBe("1h");
    expect(durationWords(3660)).toBe("1h 1m");
  });

  it("stops reporting seconds once the number is hours long", () => {
    expect(durationWords(3661)).toBe("1h 1m");
  });

  it("reads zero as zero, not as an empty string", () => {
    expect(durationWords(0)).toBe("0s");
    expect(durationWords(-5)).toBe("0s");
  });
});

describe("describeBlockActivity", () => {
  it("states the split in words and never as a percentage", () => {
    const description = describeBlockActivity(
      slot(0, { activeSeconds: 450, idleSeconds: 150, activityRatio: 0.75 }),
    );

    expect(description.split).toBe("Active 7m 30s · Idle 2m 30s");
    expect(description.split).not.toContain("%");
    expect(description.headline).not.toContain("%");
  });

  it("names the application the block was spent on", () => {
    expect(describeBlockActivity(slot(0)).headline).toBe("Code");
    expect(describeBlockActivity(slot(0)).apps).toEqual(["Code"]);
  });

  it("calls an idle-dominated block idle rather than naming the app underneath it", () => {
    const description = describeBlockActivity(
      slot(0, { activeSeconds: 100, idleSeconds: 500, activityRatio: 0.16 }),
    );

    expect(description.headline).toBe("Idle");
  });

  it("names a declared break, which is never photographed", () => {
    const description = describeBlockActivity(
      slot(0, { activeSeconds: 0, idleSeconds: 0, breakSeconds: 600, activityRatio: 0 }),
    );

    expect(description.headline).toBe("On a break");
    expect(description.split).toBe("Break 10m");
  });

  it("treats an offline stretch as information, not as an absence", () => {
    const description = describeBlockActivity(
      slot(0, { activeSeconds: 0, offlineSeconds: 600, activityRatio: null }),
    );

    expect(description.headline).toBe("Offline");
    expect(description.split).toBe("Offline 10m");
  });

  it("admits when the timeline has nothing for the block at all", () => {
    const description = describeBlockActivity(null);

    expect(description.headline).toBe("Activity not recorded");
    expect(description.apps).toEqual([]);
    expect(description.bar).toEqual({ active: 0, idle: 0, break: 0, offline: 0 });
  });

  it("emits bar fractions that tile the block exactly", () => {
    const { bar } = describeBlockActivity(
      slot(0, { activeSeconds: 300, idleSeconds: 150, breakSeconds: 60, offlineSeconds: 90 }),
    );

    expect(bar.active + bar.idle + bar.break + bar.offline).toBeCloseTo(1, 10);
    expect(bar.active).toBeCloseTo(0.5, 10);
  });
});

describe("buildReviewRows", () => {
  it("keeps every block, so a gap in the day reads as a gap", () => {
    const rows = buildReviewRows(
      { blocks: [block(0), block(10, [capture(at(12))]), block(20)], slots: [] },
      { formatTime: hhmm },
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.hasCapture)).toEqual([false, true, false]);
  });

  it("labels the block with its time range", () => {
    const rows = buildReviewRows({ blocks: [block(0)], slots: [] }, { formatTime: hhmm });

    expect(rows[0]?.timeLabel).toBe("09:00 – 09:10");
  });

  it("pairs each block with the activity that produced it", () => {
    const rows = buildReviewRows(
      {
        blocks: [block(0, [capture(at(3))]), block(10)],
        slots: [slot(0), slot(10, { activeSeconds: 0, idleSeconds: 600, activityRatio: 0 })],
      },
      { formatTime: hhmm },
    );

    expect(rows[0]?.activity.headline).toBe("Code");
    expect(rows[1]?.activity.headline).toBe("Idle");
  });

  it("still pairs when the two grids are offset from each other", () => {
    // The screenshot window is sliced from `from`; timeline slots are anchored to
    // wall-clock multiples of the unit. A zone whose offset is not a whole number of
    // ten-minute steps puts them half a block apart, and matching on an exact
    // timestamp would silently drop the activity column for the entire day.
    const rows = buildReviewRows(
      {
        blocks: [block(3, [capture(at(7))]), block(13)],
        slots: [
          slot(0),
          slot(10, { activeSeconds: 0, idleSeconds: 600, activityRatio: 0, topApps: [] }),
        ],
      },
      { formatTime: hhmm },
    );

    // Each block takes the slot covering its midpoint — 09:08 and 09:18 — rather
    // than the slot that happens to share its start.
    expect(rows[0]?.activity.headline).toBe("Code");
    expect(rows[1]?.activity.headline).toBe("Idle");
  });

  it("marks a capture whose URL could not be signed as unavailable", () => {
    const rows = buildReviewRows(
      {
        blocks: [block(0, [capture(at(1), { url: null, thumbnailUrl: null })])],
        slots: [],
      },
      { formatTime: hhmm },
    );

    expect(rows[0]?.captures[0]?.status).toBe("unavailable");
  });

  it("falls back to the full image while no thumbnail has been uploaded", () => {
    const rows = buildReviewRows(
      {
        blocks: [block(0, [capture(at(1), { id: 42, thumbnailUrl: null })])],
        slots: [],
      },
      { formatTime: hhmm },
    );

    expect(rows[0]?.captures[0]?.thumbnailUrl).toBe("https://signed.example/full/42");
    expect(rows[0]?.captures[0]?.status).toBe("ready");
  });

  it("carries the monitor count so a multi-display moment can be badged", () => {
    const twoScreens = block(0, [capture(at(1)), capture(at(1))]);
    twoScreens.monitorCount = 2;

    const rows = buildReviewRows({ blocks: [twoScreens], slots: [] }, { formatTime: hhmm });

    expect(rows[0]?.monitorCount).toBe(2);
    expect(rows[0]?.captures).toHaveLength(2);
  });
});

describe("flattenCaptures", () => {
  it("walks the captures in day order across block boundaries", () => {
    const rows = buildReviewRows(
      {
        blocks: [
          block(0, [capture(at(1), { id: 101 }), capture(at(4), { id: 102 })]),
          block(10),
          block(20, [capture(at(21), { id: 103 })]),
        ],
        slots: [],
      },
      { formatTime: hhmm },
    );

    const flat = flattenCaptures(rows);

    expect(flat.map((item) => item.id)).toEqual([101, 102, 103]);
    expect(flat[2]?.index).toBe(2);
    expect(flat[2]?.blockLabel).toBe("09:20 – 09:30");
  });
});

describe("stepCapture", () => {
  it("stops at the ends instead of wrapping into the wrong day", () => {
    expect(stepCapture(0, -1, 3)).toBe(0);
    expect(stepCapture(2, 1, 3)).toBe(2);
    expect(stepCapture(1, 1, 3)).toBe(2);
  });

  it("has no selection when there is nothing to select", () => {
    expect(stepCapture(0, 1, 0)).toBe(-1);
  });
});

describe("resignAfterMs", () => {
  it("re-signs before the URLs die rather than after", () => {
    // Signed URLs live 600s. Refetching at expiry means every tile breaks first.
    expect(resignAfterMs(600)).toBeLessThan(600_000);
    expect(resignAfterMs(600)).toBe(480_000);
  });

  it("does not poll when the API did not state a lifetime", () => {
    expect(resignAfterMs(0)).toBe(false);
    expect(resignAfterMs(Number.NaN)).toBe(false);
  });

  it("never polls faster than half a minute, whatever the API says", () => {
    expect(resignAfterMs(5)).toBe(30_000);
  });
});

describe("noteImageFailure", () => {
  it("treats the first failure as an expired URL worth re-signing", () => {
    const result = noteImageFailure({}, 7);

    expect(result.action).toBe("refetch");
  });

  it("gives up after a fresh URL fails too, instead of looping forever", () => {
    const first = noteImageFailure({}, 7);
    const second = noteImageFailure(first.state, 7);

    expect(second.action).toBe("unavailable");
  });

  it("counts each capture separately", () => {
    const first = noteImageFailure({}, 7);
    const other = noteImageFailure(first.state, 8);

    expect(other.action).toBe("refetch");
  });
});
