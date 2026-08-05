import { describe, expect, it } from "vitest";

import { activeTabHref, dayHref, employeeTabs, withSearch } from "./tabs";

const tabs = employeeTabs("abc");

describe("employeeTabs", () => {
  it("is scope 4.4's seven sections, Overview first", () => {
    expect(tabs.map((tab) => tab.label)).toEqual([
      "Overview",
      "Timeline",
      "Screenshots",
      "Apps",
      "Websites",
      "Reports",
      "Devices",
    ]);
  });

  it("roots Overview at the person's own path so a bare link lands somewhere", () => {
    expect(tabs[0]?.href).toBe("/people/abc");
    expect(tabs[1]?.href).toBe("/people/abc/timeline");
  });

  it("encodes the id, so a path segment cannot be smuggled through it", () => {
    expect(employeeTabs("a/b")[0]?.href).toBe("/people/a%2Fb");
  });
});

describe("activeTabHref", () => {
  it("picks Overview on the person's own path", () => {
    expect(activeTabHref("/people/abc", tabs)).toBe("/people/abc");
  });

  it("picks the deepest match, not the first prefix", () => {
    // A bare startsWith lights Overview on every tab — the same defect that lit
    // "My activity" on "/members".
    expect(activeTabHref("/people/abc/timeline", tabs)).toBe("/people/abc/timeline");
    expect(activeTabHref("/people/abc/screenshots", tabs)).toBe("/people/abc/screenshots");
  });

  it("stays lit on a child route of a tab", () => {
    expect(activeTabHref("/people/abc/screenshots/17", tabs)).toBe("/people/abc/screenshots");
  });

  it("does not match a different person whose id starts the same", () => {
    expect(activeTabHref("/people/abcd", tabs)).toBeNull();
    expect(activeTabHref("/people/abcd/timeline", tabs)).toBeNull();
  });

  it("returns null for a path outside the person's section", () => {
    expect(activeTabHref("/people", tabs)).toBeNull();
    expect(activeTabHref("/activity", tabs)).toBeNull();
  });
});

describe("withSearch", () => {
  it("carries the range across a tab change — the URL is the state", () => {
    expect(withSearch("/people/abc/timeline", "date=2026-08-04")).toBe(
      "/people/abc/timeline?date=2026-08-04",
    );
  });

  it("accepts a leading question mark without doubling it", () => {
    expect(withSearch("/people/abc", "?date=2026-08-04")).toBe("/people/abc?date=2026-08-04");
  });

  it("leaves the href alone when there is nothing to carry", () => {
    expect(withSearch("/people/abc", "")).toBe("/people/abc");
    expect(withSearch("/people/abc", null)).toBe("/people/abc");
    expect(withSearch("/people/abc", "?")).toBe("/people/abc");
  });
});

describe("dayHref", () => {
  it("sets the day without disturbing anything else in the query", () => {
    expect(dayHref("/people/abc", "date=2026-08-05&tz=x", "2026-08-04")).toBe(
      "/people/abc?date=2026-08-04&tz=x",
    );
  });

  it("adds the day when the URL had none", () => {
    expect(dayHref("/people/abc", "", "2026-08-04")).toBe("/people/abc?date=2026-08-04");
  });

  it("clears the day for today, so the default URL stays clean and shareable", () => {
    expect(dayHref("/people/abc", "date=2026-08-04", null)).toBe("/people/abc");
    expect(dayHref("/people/abc", "tab=1&date=2026-08-04", null)).toBe("/people/abc?tab=1");
  });
});
