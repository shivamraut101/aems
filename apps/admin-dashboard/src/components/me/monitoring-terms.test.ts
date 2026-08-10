import { describe, expect, it } from "vitest";

import {
  MONITORING_PROMISES,
  WHY_THIS_EXISTS,
  capturesPerWorkingDay,
  collectedItems,
  idleCadence,
  platformLabel,
  readsBrowserAddress,
  screenshotCadence,
  toPolicyTerms,
  type PolicyTerms,
} from "./monitoring-terms";

const policy: PolicyTerms = {
  version: "2026.08.4",
  name: "Standard Monitoring Policy",
  screenshotIntervalSeconds: 600,
  idleThresholdSeconds: 60,
  trackedCategories: ["development", "communication"],
};

describe("platform capability", () => {
  it("reads a browser address on macOS only", () => {
    expect(readsBrowserAddress("macos")).toBe(true);
    expect(readsBrowserAddress("windows")).toBe(false);
    expect(readsBrowserAddress("android")).toBe(false);
  });

  it("labels every platform the schema allows", () => {
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("macos")).toBe("macOS");
    expect(platformLabel("android")).toBe("Android");
  });
});

describe("policy cadence", () => {
  it("states the interval in the policy's own words", () => {
    expect(screenshotCadence(policy)).toBe("about every 10 min");
    expect(idleCadence(policy)).toBe("for 1 min");
  });

  /**
   * A 30-second idle threshold is legal (`idleThresholdSeconds >= 30`) and must not be
   * rounded to "0m" the way worked-time formatting would render it.
   */
  it("keeps sub-minute thresholds legible", () => {
    expect(idleCadence({ ...policy, idleThresholdSeconds: 30 })).toBe("for 30 sec");
  });

  it("hedges rather than inventing numbers when no policy is published", () => {
    expect(screenshotCadence(null)).toBe("at regular intervals");
    expect(idleCadence(null)).toBe("for a few minutes");
    expect(capturesPerWorkingDay(null)).toBe(0);
  });

  it("turns the interval into a count a person can picture", () => {
    expect(capturesPerWorkingDay(policy)).toBe(48);
    expect(capturesPerWorkingDay({ ...policy, screenshotIntervalSeconds: 1800 })).toBe(16);
  });
});

describe("toPolicyTerms", () => {
  it("maps the stored row onto the terms", () => {
    expect(
      toPolicyTerms({
        id: "p1",
        company_id: "c1",
        version: "2026.08.4",
        name: "Standard Monitoring Policy",
        screenshot_interval_seconds: 600,
        idle_threshold_seconds: 60,
        max_open_break_seconds: 10800,
        tracked_categories: ["development"],
        created_at: "2026-08-05T13:31:48.000Z",
        updated_at: "2026-08-05T13:31:48.000Z",
      }),
    ).toEqual({
      version: "2026.08.4",
      name: "Standard Monitoring Policy",
      screenshotIntervalSeconds: 600,
      idleThresholdSeconds: 60,
      trackedCategories: ["development"],
    });
  });

  /** `GET /api/policies/current` answers 200 null for a company that has published nothing. */
  it("carries a company with no published policy through as null", () => {
    expect(toPolicyTerms(null)).toBeNull();
    expect(toPolicyTerms(undefined)).toBeNull();
  });
});

describe("collectedItems", () => {
  it("quotes the live interval and threshold rather than describing them vaguely", () => {
    const items = collectedItems("macos", policy);
    const screenshots = items.find((item) => item.title === "Screenshots");
    const idle = items.find((item) => item.title === "Idle periods");

    expect(screenshots?.detail).toContain("about every 10 min");
    expect(idle?.detail).toContain("for 1 min");
  });

  /**
   * CLAUDE.md open item 6. `get-windows` reads a tab address only on macOS, so a
   * Windows machine must say it cannot — the agent's own consent screen already does,
   * and a dashboard that promised more would contradict the screen the person actually
   * accepted.
   */
  it("promises website domains on macOS", () => {
    const line = collectedItems("macos", policy).find((item) =>
      item.title.includes("Website domains"),
    );

    expect(line).toBeDefined();
    expect(line?.absent).toBeUndefined();
  });

  it("states the absence on Windows instead of dropping the subject", () => {
    const items = collectedItems("windows", policy);
    const line = items.find((item) => item.title.startsWith("Not the websites"));

    expect(line?.absent).toBe(true);
    expect(items.some((item) => item.title === "Website domains you visit")).toBe(false);
  });

  it("never claims a keystroke is recorded, and says so explicitly", () => {
    const text = collectedItems("windows", policy)
      .map((item) => `${item.title} ${item.detail}`)
      .join(" ");

    expect(text).toContain("What you type is never recorded");
    expect(text).toContain("Not your keystrokes");
  });

  it("does not offer a phone a screenshot line it has no capability for", () => {
    const items = collectedItems("android", policy);

    expect(items.some((item) => item.title === "Screenshots")).toBe(false);
    expect(items.some((item) => item.title === "Applications you use")).toBe(false);
    expect(items.some((item) => item.title === "Apps you use on this phone")).toBe(true);
  });

  /** Non-negotiable #6: location tracking is not implemented, and the phone says so. */
  it("states that a phone does not report location", () => {
    const line = collectedItems("android", policy).find((item) =>
      item.title.includes("Not your location"),
    );

    expect(line?.absent).toBe(true);
    expect(line?.detail).toContain("not built into this product");
  });
});

describe("framing", () => {
  /**
   * docs/design.md forbids surveillance framing in UI copy. This is the page an
   * employee reads about being monitored, so it is the page most likely to slip.
   */
  it("uses no surveillance vocabulary", () => {
    const corpus = [
      WHY_THIS_EXISTS,
      ...MONITORING_PROMISES.map((promise) => `${promise.title} ${promise.detail}`),
      ...collectedItems("windows", policy).map((item) => `${item.title} ${item.detail}`),
      ...collectedItems("android", policy).map((item) => `${item.title} ${item.detail}`),
    ]
      .join(" ")
      .toLowerCase();

    for (const word of ["spy", "surveil", "catch", "watch you", "secretly"]) {
      expect(corpus).not.toContain(word);
    }
  });

  it("states all three of the promises the product is obliged to keep", () => {
    const titles = MONITORING_PROMISES.map((promise) => promise.title).join(" ");

    expect(titles).toContain("without your agreement");
    expect(titles).toContain("never silent");
    expect(titles).toContain("read everything recorded about you");
  });
});
