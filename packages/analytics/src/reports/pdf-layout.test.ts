import { describe, expect, it } from "vitest";

import { PAGE_SIZES, planPdf, sanitiseWinAnsi } from "./pdf-layout.js";
import type { ReportDocument, ReportRow } from "./types.js";

function rows(count: number): ReportRow[] {
  return Array.from({ length: count }, (_, i) => ({
    cells: { application: `App ${i}`, duration: 60 * (i + 1) },
  }));
}

function doc(rowCount: number): ReportDocument {
  return {
    kind: "app_usage",
    title: "Apps & URLs",
    subtitle: "Acme Ltd",
    periodStart: "2026-08-04T00:00:00.000Z",
    periodEnd: "2026-08-05T00:00:00.000Z",
    generatedAt: "2026-08-05T10:00:00.000Z",
    grouping: "application",
    decimalDuration: false,
    rowCount,
    truncated: false,
    notes: [],
    sections: [
      {
        heading: "Applications",
        columns: [
          { id: "application", label: "Application", format: "text", align: "left" },
          { id: "duration", label: "Duration", format: "duration", align: "right" },
        ],
        rows: rows(rowCount),
        totals: { cells: { application: "Total", duration: 60 * rowCount } },
      },
    ],
  };
}

describe("sanitiseWinAnsi", () => {
  it("leaves ASCII alone", () => {
    expect(sanitiseWinAnsi("Visual Studio Code")).toBe("Visual Studio Code");
  });

  it("keeps a character the standard PDF fonts can actually draw", () => {
    // The 14 standard fonts are WinAnsi-encoded; é is in that set, so it survives.
    expect(sanitiseWinAnsi("café")).toBe("café");
  });

  it("folds a macron away rather than throwing on drawText", () => {
    // A name like "Tāne" used to crash the whole report. Losing the diacritic is
    // strictly better than losing the report.
    expect(sanitiseWinAnsi("Tāne")).toBe("Tane");
  });

  it("substitutes a script the font cannot represent at all", () => {
    expect(sanitiseWinAnsi("नमस्ते")).toMatch(/^\?+$/);
  });

  it("flattens newlines and tabs so a cell cannot break the row grid", () => {
    expect(sanitiseWinAnsi("a\nb\tc")).toBe("a b c");
  });
});

describe("planPdf", () => {
  it("produces a landscape A4 page by default so a wide table fits", () => {
    const plan = planPdf(doc(3));
    expect(plan.pageWidth).toBe(PAGE_SIZES.a4.height);
    expect(plan.pageHeight).toBe(PAGE_SIZES.a4.width);
    expect(plan.pages.length).toBe(1);
  });

  it("honours an explicit portrait orientation", () => {
    const plan = planPdf(doc(3), { orientation: "portrait" });
    expect(plan.pageWidth).toBe(PAGE_SIZES.a4.width);
  });

  it("prints the title and the period on the first page", () => {
    const texts = planPdf(doc(1)).pages[0]?.texts.map((t) => t.text) ?? [];
    expect(texts).toContain("Apps & URLs");
    expect(texts.join(" ")).toContain("2026-08-04");
  });

  it("prints the column headers and the formatted cells", () => {
    const texts = planPdf(doc(1)).pages[0]?.texts.map((t) => t.text) ?? [];
    expect(texts).toContain("Application");
    expect(texts).toContain("App 0");
    expect(texts).toContain("1m");
  });

  it("paginates rather than drawing off the bottom of the page", () => {
    const plan = planPdf(doc(200));
    expect(plan.pages.length).toBeGreaterThan(1);

    for (const page of plan.pages) {
      for (const text of page.texts) {
        expect(text.y).toBeGreaterThanOrEqual(0);
        expect(text.y).toBeLessThanOrEqual(plan.pageHeight);
      }
    }
  });

  it("repeats the column header on every page", () => {
    const plan = planPdf(doc(200));
    for (const page of plan.pages) {
      expect(page.texts.map((t) => t.text)).toContain("Application");
    }
  });

  it("keeps every cell inside the page width", () => {
    const plan = planPdf(doc(40));
    for (const page of plan.pages) {
      for (const text of page.texts) {
        expect(text.x).toBeGreaterThanOrEqual(0);
        expect(text.x).toBeLessThan(plan.pageWidth);
      }
    }
  });

  it("draws the totals row on the last page", () => {
    const plan = planPdf(doc(200));
    const last = plan.pages[plan.pages.length - 1];
    expect(last?.texts.map((t) => t.text)).toContain("Total");
  });

  it("sanitises every string it emits", () => {
    const source = doc(1);
    const first = source.sections[0]?.rows[0];
    if (first) first.cells["application"] = "Tāne's नमस्ते app";

    const texts = planPdf(source).pages[0]?.texts.map((t) => t.text) ?? [];
    expect(texts.some((t) => t.includes("Tane's"))).toBe(true);
    expect(texts.join("")).not.toContain("ā");
  });

  it("truncates a cell that is too wide for its column instead of overprinting the next one", () => {
    const source = doc(1);
    const first = source.sections[0]?.rows[0];
    if (first) first.cells["application"] = "x".repeat(500);

    const texts = planPdf(source).pages[0]?.texts.map((t) => t.text) ?? [];
    const long = texts.find((t) => t.startsWith("xxx"));
    expect(long).toBeDefined();
    expect(long!.length).toBeLessThan(500);
    expect(long!.endsWith("...")).toBe(true);
  });

  it("renders decimal hours when the document asks for them", () => {
    const texts = planPdf({ ...doc(1), decimalDuration: true }).pages[0]?.texts.map((t) => t.text) ?? [];
    expect(texts).toContain("0.02");
  });
});
