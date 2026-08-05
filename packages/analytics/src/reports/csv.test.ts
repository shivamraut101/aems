import { describe, expect, it } from "vitest";

import { escapeCsvField, renderCsv } from "./csv.js";
import type { ReportDocument } from "./types.js";

const doc: ReportDocument = {
  kind: "app_usage",
  title: "Apps & URLs",
  subtitle: "Acme Ltd",
  periodStart: "2026-08-04T00:00:00.000Z",
  periodEnd: "2026-08-05T00:00:00.000Z",
  generatedAt: "2026-08-05T10:00:00.000Z",
  grouping: "application",
  decimalDuration: false,
  rowCount: 2,
  truncated: false,
  notes: [],
  sections: [
    {
      heading: "Applications",
      columns: [
        { id: "application", label: "Application", format: "text", align: "left" },
        { id: "duration", label: "Duration", format: "duration", align: "right" },
      ],
      rows: [
        { cells: { application: "VS Code", duration: 27_000 } },
        { cells: { application: "Chrome", duration: 7_200 } },
      ],
      totals: { cells: { application: "Total", duration: 34_200 } },
    },
  ],
};

describe("escapeCsvField", () => {
  it("quotes every field, even a plain one", () => {
    // Unconditional quoting removes a whole class of separator/newline bug and
    // costs two bytes a cell.
    expect(escapeCsvField("VS Code", ",")).toBe('"VS Code"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('say "hi"', ",")).toBe('"say ""hi"""');
  });

  it("neutralises a formula so Excel does not execute it", () => {
    // Window titles are attacker-influenced text and this file gets opened in Excel.
    expect(escapeCsvField("=1+1", ",")).toBe(`"'=1+1"`);
    expect(escapeCsvField("+44 7700 900000", ",")).toBe(`"'+44 7700 900000"`);
    expect(escapeCsvField("-cmd|' /c calc'", ",")).toBe(`"'-cmd|' /c calc'"`);
    expect(escapeCsvField("@SUM(A1)", ",")).toBe(`"'@SUM(A1)"`);
  });

  it("neutralises the tab and carriage-return lead-ins too", () => {
    expect(escapeCsvField("\tcmd", ",")).toBe(`"'\tcmd"`);
    expect(escapeCsvField("\rcmd", ",")).toBe(`"'\rcmd"`);
  });

  it("leaves an ordinary leading character alone", () => {
    expect(escapeCsvField("Total", ",")).toBe('"Total"');
    expect(escapeCsvField("", ",")).toBe('""');
  });
});

describe("renderCsv", () => {
  it("starts with a UTF-8 BOM so Excel does not mangle non-ASCII names", () => {
    expect(renderCsv(doc).startsWith("﻿")).toBe(true);
  });

  it("uses CRLF line endings", () => {
    const body = renderCsv(doc);
    expect(body.includes("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(body)).toBe(false);
  });

  it("emits the column header row and one row per record", () => {
    const lines = renderCsv(doc).split("\r\n");
    expect(lines).toContain('"Application","Duration"');
    expect(lines).toContain('"VS Code","7h 30m"');
    expect(lines).toContain('"Chrome","2h 0m"');
  });

  it("emits the totals row", () => {
    expect(renderCsv(doc).split("\r\n")).toContain('"Total","9h 30m"');
  });

  it("carries the report identity so a downloaded file explains itself", () => {
    const body = renderCsv(doc);
    expect(body).toContain('"Apps & URLs"');
    expect(body).toContain('"2026-08-04T00:00:00.000Z"');
  });

  it("switches duration columns to decimal hours when the document asks for it", () => {
    const lines = renderCsv({ ...doc, decimalDuration: true }).split("\r\n");
    expect(lines).toContain('"VS Code","7.50"');
  });

  it("honours a semicolon separator for locales where comma is the decimal mark", () => {
    const lines = renderCsv(doc, { separator: ";" }).split("\r\n");
    expect(lines).toContain('"Application";"Duration"');
  });

  it("renders every section, each with its own header row", () => {
    const twoSections: ReportDocument = {
      ...doc,
      sections: [
        { ...doc.sections[0]!, heading: "First" },
        { ...doc.sections[0]!, heading: "Second" },
      ],
    };
    const body = renderCsv(twoSections);
    expect(body).toContain('"First"');
    expect(body).toContain('"Second"');
  });

  it("writes the notes so a truncated report admits it in the file itself", () => {
    const body = renderCsv({ ...doc, notes: ["Row limit reached; totals are partial."] });
    expect(body).toContain('"Row limit reached; totals are partial."');
  });
});
