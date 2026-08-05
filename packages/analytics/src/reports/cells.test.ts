import { describe, expect, it } from "vitest";

import { effectiveFormat, formatCell, formatDecimalHours, formatDuration } from "./cells.js";

describe("formatDuration", () => {
  it("renders hours and minutes", () => {
    expect(formatDuration(27_000)).toBe("7h 30m");
  });

  it("drops the hour part below an hour", () => {
    expect(formatDuration(2_700)).toBe("45m");
  });

  it("renders zero as 0m rather than an empty string", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("rounds seconds to the nearest minute without carrying past 60", () => {
    // 1h 59m 59s must not render as "1h 60m".
    expect(formatDuration(7199)).toBe("2h 0m");
  });

  it("treats a negative or non-finite input as zero rather than emitting nonsense", () => {
    expect(formatDuration(-10)).toBe("0m");
    expect(formatDuration(Number.NaN)).toBe("0m");
  });
});

describe("formatDecimalHours", () => {
  it("renders two decimal places so a spreadsheet can sum the column", () => {
    expect(formatDecimalHours(27_000)).toBe("7.50");
    expect(formatDecimalHours(4_500)).toBe("1.25");
    expect(formatDecimalHours(0)).toBe("0.00");
  });
});

describe("effectiveFormat", () => {
  it("swaps duration for decimal hours when the caller asked for decimals", () => {
    expect(effectiveFormat("duration", true)).toBe("decimalHours");
  });

  it("leaves every other format alone", () => {
    expect(effectiveFormat("duration", false)).toBe("duration");
    expect(effectiveFormat("percent", true)).toBe("percent");
    expect(effectiveFormat("text", true)).toBe("text");
  });
});

describe("formatCell", () => {
  it("renders a percent from a 0..1 ratio", () => {
    expect(formatCell(0.86, "percent")).toBe("86%");
    expect(formatCell(1, "percent")).toBe("100%");
  });

  it("renders an ISO instant as a calendar date", () => {
    expect(formatCell("2026-08-05T09:05:00.000Z", "date")).toBe("2026-08-05");
  });

  it("renders an ISO instant as a wall clock time", () => {
    expect(formatCell("2026-08-05T09:05:00.000Z", "time")).toBe("09:05");
  });

  it("renders a null as an empty string in every format", () => {
    expect(formatCell(null, "duration")).toBe("");
    expect(formatCell(null, "percent")).toBe("");
    expect(formatCell(null, "text")).toBe("");
    expect(formatCell(null, "date")).toBe("");
  });

  it("renders counts and raw seconds as plain integers", () => {
    expect(formatCell(3, "count")).toBe("3");
    expect(formatCell(27_000, "seconds")).toBe("27000");
  });

  it("passes text through untouched", () => {
    expect(formatCell("Visual Studio Code", "text")).toBe("Visual Studio Code");
  });
});
