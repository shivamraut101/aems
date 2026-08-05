import { effectiveFormat, formatCell } from "./cells.js";
import type { ReportDocument, ReportRow, ReportSection } from "./types.js";

export interface CsvOptions {
  /** Comma, or semicolon for locales where the comma is the decimal mark. */
  separator?: "," | ";";
  /** Off only for tests that want to assert on raw text. */
  bom?: boolean;
}

/** Excel reads a CSV as the system codepage unless a BOM says otherwise. */
const BOM = "﻿";

/** Excel and Numbers both want CRLF; LF alone produces one giant row in some versions. */
const EOL = "\r\n";

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Window titles and application names are attacker-influenced text and this file is
 * opened in Excel by an administrator, so a cell reading `=cmd|' /c calc'!A1` is a
 * remote-code-execution path, not a formatting quirk.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Quotes a field unconditionally.
 *
 * Conditional quoting is where CSV bugs live: a separator, a newline or a quote
 * inside a value each need a different rule, and getting one wrong shifts every
 * later column. Two bytes per cell buys the whole class away.
 */
export function escapeCsvField(value: string, _separator: "," | ";"): string {
  const first = value.slice(0, 1);
  const guarded = FORMULA_LEAD.has(first) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function renderCsv(document: ReportDocument, options: CsvOptions = {}): string {
  const separator = options.separator ?? ",";
  const lines: string[] = [];

  const row = (fields: string[]): void => {
    lines.push(fields.map((f) => escapeCsvField(f, separator)).join(separator));
  };

  row([document.title]);
  if (document.subtitle) row([document.subtitle]);
  row(["Period start", document.periodStart]);
  row(["Period end", document.periodEnd]);
  row(["Generated at", document.generatedAt]);
  row(["Grouped by", document.grouping]);
  for (const note of document.notes) row([note]);

  for (const section of document.sections) {
    lines.push("");
    row([section.heading]);
    renderSection(section, document.decimalDuration, row);
  }

  return (options.bom === false ? "" : BOM) + lines.join(EOL) + EOL;
}

function renderSection(
  section: ReportSection,
  decimalDuration: boolean,
  row: (fields: string[]) => void,
): void {
  row(section.columns.map((column) => column.label));

  for (const record of section.rows) {
    row(cellsOf(record, section, decimalDuration));
  }

  if (section.totals) {
    row(cellsOf(section.totals, section, decimalDuration));
  }
}

function cellsOf(record: ReportRow, section: ReportSection, decimalDuration: boolean): string[] {
  return section.columns.map((column) =>
    formatCell(record.cells[column.id] ?? null, effectiveFormat(column.format, decimalDuration)),
  );
}
