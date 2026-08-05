import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import {
  SCREENSHOT_INTERVAL_OPTIONS,
  intervalLabel,
  monitoringConsequence,
  policyState,
  screenshotsPerDay,
  type PolicyRecord,
} from "./settings-view";

const policy: PolicyRecord = {
  id: "pol-1",
  company_id: "co-1",
  version: "2026.1",
  name: "Standard monitoring policy",
  screenshot_interval_seconds: 300,
  idle_threshold_seconds: 120,
  tracked_categories: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("intervalLabel", () => {
  it("renders whole minutes as minutes", () => {
    expect(intervalLabel(60)).toBe("1 min");
    expect(intervalLabel(300)).toBe("5 min");
    expect(intervalLabel(1800)).toBe("30 min");
  });

  it("renders sub-minute thresholds as seconds", () => {
    expect(intervalLabel(30)).toBe("30 sec");
  });

  it("keeps a value that is not a whole number of minutes honest", () => {
    expect(intervalLabel(90)).toBe("1 min 30 sec");
  });

  it("renders an hour or more in hours", () => {
    expect(intervalLabel(3600)).toBe("1 h");
    expect(intervalLabel(5400)).toBe("1 h 30 min");
  });
});

describe("SCREENSHOT_INTERVAL_OPTIONS", () => {
  it("offers exactly the five intervals scope 2.3 names", () => {
    expect(SCREENSHOT_INTERVAL_OPTIONS.map((option) => option.seconds)).toEqual([
      60, 300, 600, 900, 1800,
    ]);
  });

  it("labels each one the way the picker will read", () => {
    expect(SCREENSHOT_INTERVAL_OPTIONS.map((option) => option.label)).toEqual([
      "1 min",
      "5 min",
      "10 min",
      "15 min",
      "30 min",
    ]);
  });
});

describe("screenshotsPerDay", () => {
  it("states the volume an interval implies over an eight-hour day", () => {
    expect(screenshotsPerDay(300)).toBe(96);
    expect(screenshotsPerDay(60)).toBe(480);
  });

  it("is zero rather than Infinity for a nonsense interval", () => {
    expect(screenshotsPerDay(0)).toBe(0);
    expect(screenshotsPerDay(-5)).toBe(0);
  });
});

describe("policyState", () => {
  it("is loading while the first request is in flight", () => {
    expect(policyState({ isLoading: true, error: null, data: undefined })).toBe("loading");
  });

  it("is ready when a policy came back", () => {
    expect(policyState({ isLoading: false, error: null, data: policy })).toBe("ready");
  });

  /**
   * The distinction that matters: a company with no policy row is a setup step, not
   * a fault. Rendering a red error box on day one of a demo makes an empty database
   * look like a broken deployment.
   */
  it("is missing — not error — for a 404", () => {
    expect(
      policyState({
        isLoading: false,
        error: new ApiError("That record could not be found.", 404, "not_found", null),
        data: undefined,
      }),
    ).toBe("missing");
  });

  it("is missing when the request succeeded and returned nothing", () => {
    expect(policyState({ isLoading: false, error: null, data: null })).toBe("missing");
  });

  it("is forbidden for a 403, which is a different sentence entirely", () => {
    expect(
      policyState({
        isLoading: false,
        error: new ApiError("You do not have access to this.", 403, "forbidden", null),
        data: undefined,
      }),
    ).toBe("forbidden");
  });

  it("is error for anything else", () => {
    expect(
      policyState({
        isLoading: false,
        error: new ApiError("The service is temporarily unavailable.", 503, "oops", null),
        data: undefined,
      }),
    ).toBe("error");
    expect(
      policyState({ isLoading: false, error: new NetworkError("never landed"), data: undefined }),
    ).toBe("error");
  });
});

describe("monitoringConsequence", () => {
  /**
   * Compliance copy, not decoration. Non-negotiable #1 makes consent the gate and #4
   * makes revocation immediate; a toggle that says only "Monitoring: off" leaves the
   * admin guessing whether history is deleted and when collection actually stops.
   */
  it("says what stops, what is kept, and when it takes effect", () => {
    const off = monitoringConsequence(true);
    expect(off.action).toBe("Pause monitoring");
    expect(off.detail).toContain("stops collecting");
    expect(off.detail).toContain("next");
    expect(off.detail).toContain("kept");
  });

  it("says what resuming does, and does not promise backfill", () => {
    const on = monitoringConsequence(false);
    expect(on.action).toBe("Resume monitoring");
    expect(on.detail).toContain("consent");
    expect(on.detail).not.toContain("backfill");
  });

  it("never uses surveillance language", () => {
    const forbidden = ["spy", "surveil", "catch", "watch"];
    for (const enabled of [true, false]) {
      const copy = monitoringConsequence(enabled);
      const text = `${copy.action} ${copy.detail}`.toLowerCase();
      for (const word of forbidden) expect(text).not.toContain(word);
    }
  });
});
