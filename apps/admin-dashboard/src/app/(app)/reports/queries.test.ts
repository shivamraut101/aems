import { describe, expect, it } from "vitest";

import { readKindParam, reportHistoryQuery, reportTypesQuery } from "./queries";
import { serverDateKey } from "./today";

/**
 * The two specs are asserted against the literal key and path that
 * `lib/queries/reports.ts` already uses.
 *
 * Not a tautology: the failure being guarded is a *divergence* between two modules, and
 * the only way to catch it is to write the expected value out by hand. If someone
 * renames the key in one place, this fails; if this test derived the expectation from
 * the spec it is testing, it would pass through exactly the drift that puts the
 * skeleton back on screen.
 */
describe("report query specs", () => {
  it("caches the catalogue under the key useReportTypes() reads", () => {
    expect(reportTypesQuery.queryKey).toEqual(["reportTypes"]);
    expect(reportTypesQuery.path).toBe("/api/reports/types");
  });

  it("keeps the API's envelope rather than unwrapping it", () => {
    // `useReportTypes()` still exists and unwraps `{ types }` with `select`. Caching a
    // bare array under the same key would hand that hook an array to read `.types` off,
    // and it would render an empty catalogue with nothing reporting an error.
    expect(reportTypesQuery.parse).toBeUndefined();
  });

  it("caches export history under the key useReportHistory() reads", () => {
    expect(reportHistoryQuery.queryKey).toEqual(["reportHistory"]);
    expect(reportHistoryQuery.path).toBe("/api/reports");
  });

  it("describes reads only — nothing here may be a mutation", () => {
    // A spec is prefetched during a render. A POST that changed state would run every
    // time somebody opened the page.
    expect(reportTypesQuery.method).toBeUndefined();
    expect(reportHistoryQuery.method).toBeUndefined();
  });
});

describe("readKindParam", () => {
  it("accepts every kind in the registry", () => {
    expect(readKindParam("time_and_activity")).toBe("time_and_activity");
    expect(readKindParam("app_usage")).toBe("app_usage");
    expect(readKindParam("website_usage")).toBe("website_usage");
    expect(readKindParam("work_breaks")).toBe("work_breaks");
  });

  it("answers null for anything else, leaving the default to the catalogue", () => {
    // Deliberately not "the first report kind": the caller knows which types *this
    // role* was offered, and this function does not.
    expect(readKindParam("payroll")).toBeNull();
    expect(readKindParam(undefined)).toBeNull();
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(readKindParam(["app_usage", "work_breaks"])).toBe("app_usage");
  });
});

describe("serverDateKey", () => {
  it("formats the local calendar day, zero-padded", () => {
    expect(serverDateKey(new Date(2026, 0, 9, 23, 30))).toBe("2026-01-09");
  });

  it("reads the local day, not the UTC one", () => {
    // 2026-08-05 00:30 local is still 2026-08-04 in UTC for anyone east of Greenwich,
    // and the reader picked days on their own calendar. Building the key from
    // `toISOString().slice(0, 10)` is the bug this asserts against.
    const local = new Date(2026, 7, 5, 0, 30);
    expect(serverDateKey(local)).toBe("2026-08-05");
  });
});
