import { describe, expect, it } from "vitest";

import {
  PEOPLE_COLUMNS,
  PEOPLE_TABLE_MIN_WIDTH,
  peopleColumnWidthNote,
} from "../people/columns";
import {
  DEVICE_COLUMNS,
  DEVICE_TABLE_MIN_WIDTH,
  columnWidthNote,
} from "./columns";
import {
  BREAKPOINTS,
  columnsAt,
  contentWidthAt,
  minWidthAt,
  widthAt,
  type ResponsiveColumn,
  type TableMinWidth,
} from "./table-layout";

/**
 * The measured defect, turned into arithmetic.
 *
 * `/devices` shipped `min-w-[76rem]` — 1216px — against the 992px a 1280px laptop
 * actually gives a page, so the product's flagship inventory table scrolled sideways
 * on an ordinary screen. Nothing caught it because nothing in the codebase knew how
 * wide the content box is; the number was picked to fit the columns rather than the
 * columns picked to fit the number.
 *
 * These tests are the missing knowledge. They are pure arithmetic over two data
 * declarations, which is exactly the class of thing a rendered-DOM test proves badly
 * and a table of numbers proves completely — and they fail the moment somebody adds a
 * twelfth column without saying where it starts being drawn.
 */

/** The widths that matter: the responsive standard's three, plus each breakpoint. */
const VIEWPORTS = [375, 640, 768, 1024, 1280, 1440, 1536, 1920] as const;

/** Below `md` the sidebar is hidden, so the table may scroll inside its own box. */
const SIDEBAR_VIEWPORTS = VIEWPORTS.filter((viewport) => viewport >= BREAKPOINTS.md);

function fits(columns: readonly ResponsiveColumn[], minimum: TableMinWidth, viewport: number) {
  return {
    columns: widthAt(columns, viewport),
    minWidth: minWidthAt(minimum, viewport),
    content: contentWidthAt(viewport),
  };
}

describe("contentWidthAt", () => {
  it("charges for the sidebar only once it is drawn", () => {
    // `w-60` appears at `md`. 767 -> 767 - 48; 768 -> 768 - 240 - 48.
    expect(contentWidthAt(767)).toBe(719);
    expect(contentWidthAt(768)).toBe(480);
  });

  it("reproduces the 992px the defect was measured against", () => {
    expect(contentWidthAt(1280)).toBe(992);
  });

  it("gives a 375px phone a usable box with no sidebar deducted", () => {
    expect(contentWidthAt(375)).toBe(327);
  });
});

describe("the device inventory fits the screen it is read on", () => {
  it.each(SIDEBAR_VIEWPORTS)("does not scroll the page at %ipx", (viewport) => {
    const measured = fits(DEVICE_COLUMNS, DEVICE_TABLE_MIN_WIDTH, viewport);

    // The declared minimum is what actually forces a scrollbar, so it is the one that
    // must fit. The column budgets must fit inside it, or the minimum is a fiction.
    expect(measured.columns).toBeLessThanOrEqual(measured.minWidth);
    expect(measured.minWidth).toBeLessThanOrEqual(measured.content);
  });

  it("draws seven columns at 1280px, the width the defect was reported at", () => {
    // Measured in the browser rather than guessed: with Network also at `xl` the table
    // needed 1013px inside 993px and still scrolled. This is the set that fits.
    expect(columnsAt(DEVICE_COLUMNS, 1280).map((column) => column.id)).toEqual([
      "device",
      "owner",
      "platform",
      "battery",
      "status",
      "lastSeen",
      "actions",
    ]);
  });

  it("would have failed at 1280px under the old fixed 76rem minimum", () => {
    // The regression this file exists for, stated as the number that was wrong.
    const OLD_MIN_WIDTH = 76 * 16;
    expect(OLD_MIN_WIDTH).toBeGreaterThan(contentWidthAt(1280));
    expect(minWidthAt(DEVICE_TABLE_MIN_WIDTH, 1280)).toBeLessThan(OLD_MIN_WIDTH);
  });

  it("still asks for the full width where there is room for it", () => {
    // 77rem, not the old 76rem: the revoke control is a 36px-tall default `Button`
    // rather than a 32px `sm` one, and a taller button is a wider one.
    expect(minWidthAt(DEVICE_TABLE_MIN_WIDTH, 1536)).toBe(77 * 16);
    expect(columnsAt(DEVICE_COLUMNS, 1536)).toHaveLength(DEVICE_COLUMNS.length);
  });

  it("fits inside `max-w-7xl`, which is narrower than the raw viewport at 2xl", () => {
    // `contentWidthAt` models the sidebar and the page padding but not the container
    // cap. At 1536 the page is `min(1536 - 240, 1280) - 48` = 1232, not the 1248 the
    // helper reports — so the widest tier is checked against the real number too.
    const PAGE_MAX_WIDTH = 1280;
    const capped = Math.min(1536 - 240, PAGE_MAX_WIDTH) - 48;
    expect(capped).toBe(1232);
    expect(minWidthAt(DEVICE_TABLE_MIN_WIDTH, 1536)).toBeLessThanOrEqual(capped);
  });

  it("keeps identity, presence and the revoke control at every width", () => {
    const base = columnsAt(DEVICE_COLUMNS, 320).map((column) => column.id);
    expect(base).toEqual(["device", "status", "lastSeen", "actions"]);
  });

  it("bounds how far the table can scroll inside its own box on a phone", () => {
    // A table wider than a 375px page is fine — it scrolls in its `overflow-x-auto`
    // container and the body does not. It must not be so wide that the scroll is the
    // only way to see anything at all.
    const overflow = minWidthAt(DEVICE_TABLE_MIN_WIDTH, 375) - contentWidthAt(375);
    expect(overflow).toBeGreaterThan(0);
    expect(overflow).toBeLessThan(contentWidthAt(375));
  });
});

describe("the roster fits the screen it is read on", () => {
  it.each(SIDEBAR_VIEWPORTS)("does not scroll the page at %ipx", (viewport) => {
    const measured = fits(PEOPLE_COLUMNS, PEOPLE_TABLE_MIN_WIDTH, viewport);

    expect(measured.columns).toBeLessThanOrEqual(measured.minWidth);
    expect(measured.minWidth).toBeLessThanOrEqual(measured.content);
  });

  it("fits a 768px tablet, which the old flat 44rem minimum did not", () => {
    const OLD_MIN_WIDTH = 44 * 16;
    expect(OLD_MIN_WIDTH).toBeGreaterThan(contentWidthAt(768));
    expect(minWidthAt(PEOPLE_TABLE_MIN_WIDTH, 768)).toBeLessThanOrEqual(contentWidthAt(768));
  });

  it("keeps who, whether they are monitored and when they were last seen", () => {
    expect(columnsAt(PEOPLE_COLUMNS, 320).map((column) => column.id)).toEqual([
      "name",
      "monitoring",
      "lastSeen",
    ]);
  });
});

describe("column declarations", () => {
  const ALL = [...DEVICE_COLUMNS, ...PEOPLE_COLUMNS];

  it("gates every non-base column with a literal Tailwind class", () => {
    for (const column of ALL) {
      if (column.from === "base") {
        expect(column.className).toBe("");
        continue;
      }
      // `hidden` alone would remove it everywhere; the pair is what makes it come back.
      expect(column.className).toContain("hidden");
      expect(column.className).toContain(`${column.from}:table-cell`);
    }
  });

  it("budgets a positive width for every column", () => {
    for (const column of ALL) expect(column.budget).toBeGreaterThan(0);
  });

  it("names the threshold of every gated column, and only those", () => {
    expect(columnWidthNote("device")).toBeNull();
    expect(columnWidthNote("owner")).toBe("1024px+");
    expect(columnWidthNote("battery")).toBe("1280px+");
    expect(columnWidthNote("cpu")).toBe("1536px+");
    // Moved up a tier after a browser measurement — see the note in `columns.ts`.
    expect(columnWidthNote("network")).toBe("1536px+");

    expect(peopleColumnWidthNote("name")).toBeNull();
    expect(peopleColumnWidthNote("role")).toBe("1024px+");
    expect(peopleColumnWidthNote("devices")).toBe("1280px+");
  });

  it("has no duplicate ids in either table", () => {
    for (const columns of [DEVICE_COLUMNS, PEOPLE_COLUMNS]) {
      const ids = columns.map((column) => column.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
