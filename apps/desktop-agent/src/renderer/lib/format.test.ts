import { describe, expect, it } from "vitest";

import { formatDuration, formatRelative, formatSpan } from "./format.js";

/**
 * Boundaries in the readout's arithmetic.
 *
 * Regression guards over code that already existed, verified by mutation rather than
 * by a RED-first cycle: each comparison and divisor below was broken in turn, the
 * failure observed, and the line restored.
 *
 * The bounds are chosen where a reading changes meaning — the last second before a
 * unit rolls over, and the first one after — because those are the only places a
 * rounding mistake produces a figure that is wrong rather than merely imprecise.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  it("shows an untouched day as zero rather than as an empty string", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  // Under a minute is deliberately "0m", not "45s": this figure sits next to a day's
  // work, and a seconds reading beside "7h 12m" implies a precision the tracker
  // does not have.
  it("rounds anything under a minute down to zero", () => {
    expect(formatDuration(1)).toBe("0m");
    expect(formatDuration(59)).toBe("0m");
  });

  it("turns over to minutes at exactly one minute", () => {
    expect(formatDuration(MINUTE)).toBe("1m");
  });

  it("stays in minutes for the last second before an hour", () => {
    expect(formatDuration(HOUR - 1)).toBe("59m");
  });

  // The turnover the tracked-time row hits every working day. An off-by-one here
  // reads as "60m" for an hour of work, which nobody would report as a bug.
  it("turns over to hours at exactly one hour", () => {
    expect(formatDuration(HOUR)).toBe("1h 0m");
  });

  it("carries the remainder minutes past the hour", () => {
    expect(formatDuration(HOUR + MINUTE)).toBe("1h 1m");
    expect(formatDuration(7 * HOUR + 12 * MINUTE)).toBe("7h 12m");
  });

  // No day unit: a running work session that survives midnight is a real state, and
  // "1d 1h" would invite the reader to think two days are being summed.
  it("keeps counting in hours beyond a day", () => {
    expect(formatDuration(DAY)).toBe("24h 0m");
    expect(formatDuration(DAY + HOUR + MINUTE)).toBe("25h 1m");
  });

  // Totals are derived from spans, and a clock that steps backwards can produce a
  // negative one. "-1m worked" is worse than showing nothing happened.
  it("refuses to render a negative or unusable total", () => {
    expect(formatDuration(-1)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0m");
  });
});

describe("formatSpan", () => {
  // These are the exact interval options in scope §2.3, read out of the policy and
  // placed inside the consent sentence "a picture of your screen about every …".
  it.each([
    [MINUTE, "1 minute"],
    [5 * MINUTE, "5 minutes"],
    [10 * MINUTE, "10 minutes"],
    [15 * MINUTE, "15 minutes"],
    [30 * MINUTE, "30 minutes"],
  ])("reads the %d second screenshot interval as %s", (seconds, expected) => {
    expect(formatSpan(seconds)).toBe(expected);
  });

  it("keeps the singular for one of anything", () => {
    expect(formatSpan(1)).toBe("1 second");
    expect(formatSpan(MINUTE)).toBe("1 minute");
    expect(formatSpan(HOUR)).toBe("1 hour");
  });

  it("turns over between units on the boundary", () => {
    expect(formatSpan(59)).toBe("59 seconds");
    expect(formatSpan(59 * MINUTE)).toBe("59 minutes");
    expect(formatSpan(2 * HOUR)).toBe("2 hours");
  });

  // The consent gate renders with `policy === null` whenever the policy fetch fails,
  // and a gate that reads "every 0 seconds" would be worse than a vaguer true one.
  it("degrades to a phrase rather than a nonsense interval", () => {
    expect(formatSpan(0)).toBe("a set interval");
    expect(formatSpan(-5)).toBe("a set interval");
    expect(formatSpan(Number.NaN)).toBe("a set interval");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-08-05T09:00:00.000Z");
  const ago = (ms: number): string | null => formatRelative(new Date(now - ms).toISOString(), now);

  it("calls a sync that just landed just now", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(4_000)).toBe("just now");
  });

  // A device clock a few seconds ahead of the API's is ordinary. "in 3 seconds" would
  // read as a bug rather than as the skew it is.
  it("reads a timestamp from the future as just now", () => {
    expect(formatRelative(new Date(now + 90_000).toISOString(), now)).toBe("just now");
  });

  it("starts counting seconds at five", () => {
    expect(ago(5_000)).toBe("5 seconds ago");
    expect(ago(59_000)).toBe("59 seconds ago");
  });

  it("turns over to minutes at exactly one minute", () => {
    expect(ago(MINUTE * 1000)).toBe("1 minute ago");
  });

  it("stays in minutes for the last second before an hour", () => {
    expect(ago(HOUR * 1000 - 1_000)).toBe("59 minutes ago");
  });

  it("turns over to hours at exactly one hour", () => {
    expect(ago(HOUR * 1000)).toBe("1 hour ago");
  });

  it("stays in hours for the last hour before a day", () => {
    expect(ago(DAY * 1000 - 1_000)).toBe("23 hours ago");
  });

  it("turns over to days at exactly one day", () => {
    expect(ago(DAY * 1000)).toBe("1 day ago");
  });

  // An agent that last reached the API three days ago is a device the employee should
  // ask about — folding it into "72 hours ago" buries that.
  it("keeps counting in days beyond the first", () => {
    expect(ago(3 * DAY * 1000)).toBe("3 days ago");
  });

  // `lastSyncAt` comes off the wire. The readout falls back to "No sync yet" on null,
  // which is a truthful answer; "NaN minutes ago" is not.
  it("returns null for a timestamp it cannot parse", () => {
    expect(formatRelative("not a timestamp", now)).toBeNull();
    expect(formatRelative("", now)).toBeNull();
  });
});
