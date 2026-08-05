import { describe, expect, it } from "vitest";

import {
  REPORT_KINDS,
  columnsFor,
  defaultGrouping,
  findReportType,
  getReportType,
  isGroupingAllowed,
  listReportTypes,
} from "./registry.js";

describe("report registry", () => {
  it("declares exactly the four report types scope §5 names", () => {
    expect([...REPORT_KINDS]).toEqual([
      "time_and_activity",
      "app_usage",
      "website_usage",
      "work_breaks",
    ]);
  });

  it("gives every type a label, a description and at least one grouping", () => {
    for (const kind of REPORT_KINDS) {
      const type = getReportType(kind);
      expect(type.label.length).toBeGreaterThan(0);
      expect(type.description.length).toBeGreaterThan(0);
      expect(type.groupings.length).toBeGreaterThan(0);
      expect(type.groupings).toContain(type.defaultGrouping);
    }
  });

  it("returns undefined for a kind it does not know rather than throwing at the caller", () => {
    // The API validates untrusted input through this, so it must answer rather than throw.
    expect(findReportType("nonsense")).toBeUndefined();
    expect(findReportType("time_and_activity")?.id).toBe("time_and_activity");
  });

  it("enumerates groupings — a grouping outside the list is refused", () => {
    expect(isGroupingAllowed("website_usage", "domain")).toBe(true);
    expect(isGroupingAllowed("website_usage", "application")).toBe(false);
  });

  it("defaults every type to a grouping it actually allows", () => {
    for (const kind of REPORT_KINDS) {
      expect(isGroupingAllowed(kind, defaultGrouping(kind))).toBe(true);
    }
  });

  describe("columnsFor", () => {
    it("includes an employee column only when the grouping is per employee", () => {
      const byEmployee = columnsFor("time_and_activity", "employee").map((c) => c.id);
      const byDate = columnsFor("time_and_activity", "date").map((c) => c.id);

      expect(byEmployee).toContain("employee");
      expect(byDate).not.toContain("employee");
      expect(byDate).toContain("date");
    });

    it("gives Time & Activity the tracked / active / idle / break split scope §2.2 asks for", () => {
      const ids = columnsFor("time_and_activity", "employee").map((c) => c.id);
      expect(ids).toEqual(
        expect.arrayContaining(["tracked", "active", "idle", "break", "activeRatio"]),
      );
    });

    it("gives Work Breaks a start and an end when grouped per break event", () => {
      const ids = columnsFor("work_breaks", "event").map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining(["breakStart", "breakEnd", "duration"]));
    });

    it("gives Website Usage a visit count", () => {
      expect(columnsFor("website_usage", "domain").map((c) => c.id)).toContain("visits");
    });

    it("returns no columns for a grouping the type does not allow", () => {
      expect(columnsFor("website_usage", "application")).toEqual([]);
    });

    it("uses only formats the renderers understand", () => {
      const known = new Set(["text", "seconds", "duration", "decimalHours", "date", "time", "percent", "count"]);
      for (const kind of REPORT_KINDS) {
        for (const grouping of getReportType(kind).groupings) {
          for (const column of columnsFor(kind, grouping)) {
            expect(known.has(column.format)).toBe(true);
          }
        }
      }
    });
  });

  describe("listReportTypes", () => {
    it("offers a manager every type", () => {
      expect(listReportTypes("manager").map((t) => t.id)).toEqual([...REPORT_KINDS]);
      expect(listReportTypes("super_admin").map((t) => t.id)).toEqual([...REPORT_KINDS]);
    });

    it("offers an employee only the types they may run over their own data", () => {
      // The UI must not offer an action RLS will refuse.
      const ids = listReportTypes("employee").map((t) => t.id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(getReportType(id).minRole).toBe("employee");
      }
    });
  });
});
