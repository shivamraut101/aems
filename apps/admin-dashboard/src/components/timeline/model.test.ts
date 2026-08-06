import type {
  AppUsage,
  DayTimeline,
  TimelineMarker,
  TimelineSlot,
  TimelineSpan,
  TimelineSpanKind,
} from "@aems/types";
import { describe, expect, it } from "vitest";

import {
  APP_HUES,
  LABEL_MIN_FRACTION,
  RIBBON_WIDTH,
  SPAN_FILL,
  SPAN_LABEL_FILL,
  appHue,
  buildRibbon,
  clampWindowToNow,
  fromLegacyEvents,
  hourTicks,
  isEmptyTimeline,
  railEvents,
  spanLabel,
  timelineSummary,
} from "./model";

// Local-time constructors throughout: the assertions must hold in any timezone the
// test runner happens to sit in, so nothing here parses a bare "YYYY-MM-DD" string.
function at(hour: number, minute = 0, second = 0): string {
  return new Date(2026, 7, 5, hour, minute, second, 0).toISOString();
}

const WINDOW = { from: at(9), to: at(17) }; // 8 hours = 28_800 s

function span(partial: Partial<TimelineSpan> & Pick<TimelineSpan, "start" | "end">): TimelineSpan {
  const seconds = Math.round((Date.parse(partial.end) - Date.parse(partial.start)) / 1000);
  return {
    kind: "app" as TimelineSpanKind,
    appName: "Code.exe",
    windowTitle: null,
    category: null,
    seconds,
    appCount: 1,
    topApps: [],
    ...partial,
  };
}

function usage(appName: string, seconds: number): AppUsage {
  return { appName, category: null, seconds };
}

function marker(partial: Partial<TimelineMarker> & Pick<TimelineMarker, "at">): TimelineMarker {
  return {
    kind: "clock-in",
    label: "Started work",
    detail: null,
    screenshotId: null,
    ...partial,
  };
}

function slot(partial: Partial<TimelineSlot> & Pick<TimelineSlot, "start" | "end">): TimelineSlot {
  return {
    activeSeconds: 0,
    idleSeconds: 0,
    breakSeconds: 0,
    offlineSeconds: 600,
    activityRatio: null,
    topApps: [],
    screenshots: [],
    ...partial,
  };
}

function timeline(partial: Partial<DayTimeline> = {}): DayTimeline {
  return {
    profileId: "p1",
    periodStart: WINDOW.from,
    periodEnd: WINDOW.to,
    slotSeconds: 600,
    slots: [],
    spans: [],
    markers: [],
    totals: {
      activeSeconds: 0,
      productiveSeconds: 0,
      neutralSeconds: 0,
      unproductiveSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
      offlineSeconds: 0,
      trackedSeconds: 0,
      activityRatio: null,
    },
    topApps: [],
    truncated: false,
    ...partial,
  };
}

describe("buildRibbon — proportional geometry", () => {
  it("places a span at its proportional offset and width", () => {
    const [segment] = buildRibbon([span({ start: at(13), end: at(15) })], WINDOW);

    // 13:00 is half way through a 09:00–17:00 window; two of eight hours is a quarter.
    expect(segment?.x).toBeCloseTo(RIBBON_WIDTH / 2);
    expect(segment?.width).toBeCloseTo(RIBBON_WIDTH / 4);
    expect(segment?.widthClamped).toBe(false);
  });

  it("tiles the whole window when the spans tile it", () => {
    const segments = buildRibbon(
      [
        span({ start: at(9), end: at(12) }),
        span({ start: at(12), end: at(14), kind: "idle" }),
        span({ start: at(14), end: at(17), kind: "offline" }),
      ],
      WINDOW,
    );

    const covered = segments.reduce((sum, s) => sum + s.naturalWidth, 0);
    expect(covered).toBeCloseTo(RIBBON_WIDTH);
    expect(segments[0]?.x).toBeCloseTo(0);
    expect((segments[2]?.x ?? 0) + (segments[2]?.naturalWidth ?? 0)).toBeCloseTo(RIBBON_WIDTH);
  });

  it("keeps offline spans instead of filtering them out", () => {
    const segments = buildRibbon([span({ start: at(11), end: at(12, 30), kind: "offline" })], WINDOW);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("offline");
  });

  it("clips a span that overhangs the window and drops one entirely outside it", () => {
    const segments = buildRibbon(
      [
        span({ start: at(8), end: at(10) }),
        span({ start: at(3), end: at(4) }),
        span({ start: at(18), end: at(19) }),
      ],
      WINDOW,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.x).toBeCloseTo(0);
    expect(segments[0]?.naturalWidth).toBeCloseTo(RIBBON_WIDTH / 8); // 09:00–10:00 survives
  });

  it("returns nothing for a zero-length window rather than dividing by zero", () => {
    expect(buildRibbon([span({ start: at(9), end: at(10) })], { from: at(9), to: at(9) })).toEqual([]);
  });
});

describe("buildRibbon — the 60-second minimum rendered width", () => {
  it("widens a sub-minute span to the 60-second equivalent without touching its duration", () => {
    const [segment] = buildRibbon([span({ start: at(13), end: at(13, 0, 15) })], WINDOW);

    const minWidth = (60 / 28_800) * RIBBON_WIDTH; // 3 units
    expect(segment?.width).toBeCloseTo(minWidth);
    expect(segment?.naturalWidth).toBeCloseTo(minWidth / 4);
    expect(segment?.widthClamped).toBe(true);
    // The lie would be here: the reported duration must stay 15 seconds.
    expect(segment?.seconds).toBe(15);
  });

  it("grows the widened span about its own centre and keeps it inside the viewBox", () => {
    const [middle] = buildRibbon([span({ start: at(13), end: at(13, 0, 15) })], WINDOW);
    const minWidth = (60 / 28_800) * RIBBON_WIDTH;
    expect(middle?.x).toBeCloseTo(RIBBON_WIDTH / 2 - (minWidth - minWidth / 4) / 2);

    const [first] = buildRibbon([span({ start: at(9), end: at(9, 0, 15) })], WINDOW);
    expect(first?.x).toBeCloseTo(0); // never negative

    const [last] = buildRibbon([span({ start: at(16, 59, 45), end: at(17) })], WINDOW);
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(RIBBON_WIDTH); // never overflows
  });

  it("never inflates totals: the seconds are conserved across every segment", () => {
    const spans = [
      span({ start: at(9), end: at(11) }),
      span({ start: at(11), end: at(11, 0, 5), appName: "Slack.exe" }),
      span({ start: at(11, 0, 5), end: at(11, 0, 9), appName: "Chrome.exe" }),
      span({ start: at(11, 0, 9), end: at(13) }),
    ];
    const total = spans.reduce((sum, s) => sum + s.seconds, 0);

    const segments = buildRibbon(spans, WINDOW);
    expect(segments.reduce((sum, s) => sum + s.seconds, 0)).toBe(total);
  });

  it("paints narrow segments last so a widened sliver is not overdrawn by its neighbour", () => {
    const segments = buildRibbon(
      [
        span({ start: at(9), end: at(13) }),
        span({ start: at(13), end: at(13, 0, 20), appName: "Slack.exe" }),
        span({ start: at(13, 0, 20), end: at(17) }),
      ],
      WINDOW,
    );

    const sliver = segments.find((s) => s.appName === "Slack.exe");
    expect(sliver?.paintOrder).toBeGreaterThan(segments[0]?.paintOrder ?? 0);
    expect(sliver?.paintOrder).toBeGreaterThan(segments[2]?.paintOrder ?? 0);
  });
});

describe("buildRibbon — labels", () => {
  it("shows a label only when the segment is at least 5% of the visible span", () => {
    const wide = (LABEL_MIN_FRACTION + 0.01) * 8 * 3600; // seconds
    const narrow = (LABEL_MIN_FRACTION - 0.01) * 8 * 3600;

    const segments = buildRibbon(
      [
        span({ start: at(9), end: new Date(Date.parse(at(9)) + wide * 1000).toISOString() }),
        span({
          start: at(14),
          end: new Date(Date.parse(at(14)) + narrow * 1000).toISOString(),
          appName: "Slack.exe",
        }),
      ],
      WINDOW,
    );

    expect(segments[0]?.showLabel).toBe(true);
    expect(segments[1]?.showLabel).toBe(false);
    // The name still has to be reachable — it lives in the hover title either way.
    expect(segments[1]?.title).toContain("Slack.exe");
  });

  it("labels each kind in positioning language and carries duration in the title", () => {
    expect(spanLabel(span({ start: at(9), end: at(10), appName: "Code.exe" }))).toBe("Code.exe");
    expect(spanLabel(span({ start: at(9), end: at(10), kind: "idle" }))).toBe("Idle");
    expect(spanLabel(span({ start: at(9), end: at(10), kind: "break" }))).toBe("Break");
    expect(spanLabel(span({ start: at(9), end: at(10), kind: "offline" }))).toBe("No data");
    expect(spanLabel(span({ start: at(9), end: at(10), appName: null }))).toBe("Unknown application");

    const [segment] = buildRibbon([span({ start: at(9), end: at(11) })], WINDOW);
    expect(segment?.title).toContain("2h");
  });

  it("describes a switching cluster by its app count and its real duration, not its bracket", () => {
    const cluster = span({
      start: at(10),
      end: at(10, 10),
      kind: "switching",
      appName: null,
      appCount: 7,
      seconds: 180, // deliberately shorter than the bracket
      topApps: [usage("Chrome.exe", 90), usage("Slack.exe", 60)],
    });

    expect(spanLabel(cluster)).toBe("Rapid switching · 7 apps");

    const [segment] = buildRibbon([cluster], WINDOW);
    expect(segment?.seconds).toBe(180);
    expect(segment?.title).toContain("3m");
    expect(segment?.title).toContain("Chrome.exe");
  });
});

describe("colour channels", () => {
  it("has a fill for every span kind", () => {
    const kinds: TimelineSpanKind[] = ["app", "switching", "idle", "break", "offline"];
    for (const kind of kinds) {
      expect(SPAN_FILL[kind]).toBeTruthy();
      expect(SPAN_LABEL_FILL[kind]).toBeTruthy();
    }
  });

  it("never uses the indigo accent — it is reserved for AI surfaces", () => {
    const values = [...Object.values(SPAN_FILL), ...Object.values(SPAN_LABEL_FILL)].join(" ");
    expect(values).not.toContain("--accent");
    expect(values).not.toContain("indigo");
    expect(values).not.toContain("--destructive"); // no red band beside a person's name
  });

  it("derives a stable identity hue per application", () => {
    expect(appHue("Code.exe")).toBe(appHue("Code.exe"));
    expect(appHue("Code.exe")).not.toBe(appHue("Chrome.exe"));
    expect(APP_HUES).toContain(appHue("Code.exe"));
  });

  it("keeps every identity hue clear of the indigo band", () => {
    for (const hue of APP_HUES) {
      expect(hue < 215 || hue > 265).toBe(true);
    }
  });
});

describe("hourTicks", () => {
  it("marks every hour boundary inside the window", () => {
    const ticks = hourTicks(WINDOW);

    expect(ticks).toHaveLength(9); // 09:00 through 17:00 inclusive
    expect(ticks[0]?.x).toBeCloseTo(0);
    expect(ticks[8]?.x).toBeCloseTo(RIBBON_WIDTH);
    expect(ticks[1]?.x).toBeCloseTo(RIBBON_WIDTH / 8);
  });

  it("thins the labels rather than overlapping them, keeping the gridlines", () => {
    const ticks = hourTicks(WINDOW, { maxLabels: 3 });

    expect(ticks).toHaveLength(9);
    expect(ticks.filter((tick) => tick.label !== null).length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for an empty window", () => {
    expect(hourTicks({ from: at(9), to: at(9) })).toEqual([]);
  });
});

describe("railEvents", () => {
  it("keeps markers in chronological order and carries their ready-made copy", () => {
    const events = railEvents(
      timeline({
        markers: [
          marker({ at: at(9), kind: "clock-in", label: "Started work", detail: "Windows laptop" }),
          marker({ at: at(10, 30), kind: "idle-start", label: "Idle", detail: "No input" }),
        ],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual(["clock-in", "idle-start"]);
    expect(events[0]?.detail).toBe("Windows laptop");
  });

  it("turns a long offline span into one 'No data' row instead of silence", () => {
    const events = railEvents(
      timeline({
        spans: [span({ start: at(11, 20), end: at(12, 50), kind: "offline", appName: null })],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("no-data");
    expect(events[0]?.label).toBe("No data");
    expect(events[0]?.detail).toContain("1h 30m");
  });

  it("ignores a short offline blip so the rail is not a wall of gaps", () => {
    const events = railEvents(
      timeline({ spans: [span({ start: at(11), end: at(11, 2), kind: "offline", appName: null })] }),
    );

    expect(events).toEqual([]);
  });

  it("interleaves synthesised gaps with real markers by time", () => {
    const events = railEvents(
      timeline({
        markers: [marker({ at: at(9) }), marker({ at: at(14), kind: "clock-out", label: "Stopped" })],
        spans: [span({ start: at(11), end: at(12), kind: "offline", appName: null })],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual(["clock-in", "no-data", "clock-out"]);
  });

  it("resolves a screenshot marker to the capture stored on its slot", () => {
    const events = railEvents(
      timeline({
        markers: [
          marker({ at: at(10), kind: "screenshot", label: "Screen capture", screenshotId: 7 }),
          marker({ at: at(10, 10), kind: "screenshot", label: "Screen capture", screenshotId: 8 }),
        ],
        slots: [
          slot({
            start: at(10),
            end: at(10, 10),
            screenshots: [
              {
                id: 7,
                capturedAt: at(10),
                url: "https://example.test/full.png",
                thumbnailUrl: "https://example.test/thumb.png",
                blurred: false,
                workSessionId: null,
              },
            ],
          }),
        ],
      }),
    );

    expect(events[0]?.imageUrl).toBe("https://example.test/thumb.png");
    expect(events[0]?.fullUrl).toBe("https://example.test/full.png");
    // Signing failed or the row is gone: an explicit unavailable cell, never a broken img.
    expect(events[1]?.imageUrl).toBeNull();
    expect(events[1]?.captureUnavailable).toBe(true);
  });
});

describe("fromLegacyEvents — the deprecated rail shape", () => {
  it("maps the four legacy kinds onto rail kinds", () => {
    const events = fromLegacyEvents([
      { at: at(9), kind: "session-start", title: "Started work" },
      { at: at(9, 15), kind: "app", title: "Code.exe", detail: "2h" },
      { at: at(10), kind: "screenshot", title: "Screen capture" },
      { at: at(10, 30), kind: "idle", title: "Idle" },
    ]);

    expect(events.map((event) => event.kind)).toEqual([
      "clock-in",
      "app",
      "screenshot",
      "idle-start",
    ]);
    expect(events[1]?.label).toBe("Code.exe");
    expect(events[1]?.detail).toBe("2h");
  });

  it("carries a screenshot URL through when the caller supplied one", () => {
    const [event] = fromLegacyEvents([
      { at: at(10), kind: "screenshot", title: "Capture", screenshotUrl: "https://x.test/a.png" },
    ]);

    expect(event?.imageUrl).toBe("https://x.test/a.png");
    expect(event?.fullUrl).toBe("https://x.test/a.png");
  });

  it("does not claim a capture is unavailable when the legacy shape never carried one", () => {
    const [event] = fromLegacyEvents([{ at: at(10), kind: "screenshot", title: "Capture" }]);

    expect(event?.imageUrl).toBeNull();
    expect(event?.captureUnavailable).toBe(false);
  });

  it("sorts chronologically and keys every row uniquely", () => {
    const events = fromLegacyEvents([
      { at: at(12), kind: "app", title: "Chrome.exe" },
      { at: at(9), kind: "app", title: "Chrome.exe" },
    ]);

    expect(events.map((event) => event.at)).toEqual([at(9), at(12)]);
    expect(new Set(events.map((event) => event.key)).size).toBe(2);
  });
});

describe("timelineSummary — the text alternative", () => {
  it("states the tracked total and each component in words", () => {
    const text = timelineSummary(
      timeline({
        totals: {
          activeSeconds: 6 * 3600 + 40 * 60,
          productiveSeconds: 0,
          neutralSeconds: 6 * 3600 + 40 * 60,
          unproductiveSeconds: 0,
          idleSeconds: 30 * 60,
          breakSeconds: 10 * 60,
          offlineSeconds: 90 * 60,
          trackedSeconds: 7 * 3600 + 20 * 60,
          activityRatio: 0.9,
        },
      }),
    );

    expect(text).toContain("7h 20m");
    expect(text).toContain("6h 40m");
    expect(text).toContain("active");
    expect(text).toContain("no data");
    // A bare productivity percentage is exactly what docs/design.md asks us not to lead with.
    expect(text).not.toContain("%");
  });

  it("says so plainly when nothing was recorded", () => {
    expect(timelineSummary(timeline())).toBe("No activity recorded for this day.");
  });
});

describe("isEmptyTimeline", () => {
  it("treats absent data as empty", () => {
    expect(isEmptyTimeline(null)).toBe(true);
    expect(isEmptyTimeline(undefined)).toBe(true);
    expect(isEmptyTimeline(timeline())).toBe(true);
  });

  it("is not empty when a moment was recorded even with no tracked time", () => {
    expect(isEmptyTimeline(timeline({ markers: [marker({ at: at(9) })] }))).toBe(false);
  });

  it("is not empty when there is tracked time", () => {
    const totals = {
      activeSeconds: 60,
      productiveSeconds: 0,
      neutralSeconds: 60,
      unproductiveSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
      offlineSeconds: 0,
      trackedSeconds: 60,
      activityRatio: 1,
    };
    expect(isEmptyTimeline(timeline({ totals }))).toBe(false);
  });
});

describe("clampWindowToNow", () => {
  const midnight = new Date(2026, 7, 5, 0, 0, 0, 0).toISOString();
  const nextMidnight = new Date(2026, 7, 6, 0, 0, 0, 0).toISOString();

  it("leaves a finished day exactly as the shared day control resolved it", () => {
    const window = clampWindowToNow(
      { from: midnight, to: nextMidnight },
      new Date(2026, 7, 7, 9, 0),
    );

    expect(window).toEqual({ from: midnight, to: nextMidnight });
  });

  it("stops at now for a day in progress, so the future is not painted as missing data", () => {
    const now = new Date(2026, 7, 5, 14, 0, 0, 0);
    const window = clampWindowToNow({ from: midnight, to: nextMidnight }, now);

    expect(window.from).toBe(midnight);
    expect(window.to).toBe(now.toISOString());
  });

  it("collapses to a point for a day that has not started", () => {
    const window = clampWindowToNow(
      { from: midnight, to: nextMidnight },
      new Date(2026, 7, 1, 12, 0),
    );

    expect(window.to).toBe(window.from);
  });

  it("passes an unparseable window straight through rather than inventing one", () => {
    const window = clampWindowToNow({ from: "not-a-date", to: nextMidnight }, new Date());
    expect(window).toEqual({ from: "not-a-date", to: nextMidnight });
  });
});
