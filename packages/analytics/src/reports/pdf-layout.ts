import { effectiveFormat, formatCell } from "./cells.js";
import type { ReportDocument, ReportRow, ReportSection } from "./types.js";

/**
 * A PDF page plan.
 *
 * Pure geometry — no PDF library is involved, so pagination, column widths and text
 * fitting are all unit-testable. The renderer that owns `pdf-lib` only walks this
 * and calls `drawText` / `drawLine`, which keeps the one piece that needs a native
 * runtime down to a few dozen lines with no arithmetic in it.
 */
export interface PdfTextRun {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
  /** 0..1 grey; 0 is black. Kept greyscale so a report prints identically anywhere. */
  grey: number;
}

export interface PdfLineRun {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  grey: number;
}

export interface PdfPage {
  texts: PdfTextRun[];
  lines: PdfLineRun[];
}

export interface PdfPlan {
  pageWidth: number;
  pageHeight: number;
  pages: PdfPage[];
}

export interface PdfOptions {
  orientation?: "portrait" | "landscape";
  pageSize?: keyof typeof PAGE_SIZES;
}

/** Points, portrait. */
export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

const MARGIN = 36;
const TITLE_SIZE = 16;
const META_SIZE = 9;
const HEADER_SIZE = 9;
const BODY_SIZE = 9;
const ROW_HEIGHT = 15;
const COLUMN_GAP = 8;

/**
 * Helvetica advance widths, approximated.
 *
 * Exact widths live in the font's metrics and would mean shipping a table; the
 * fitting rule here only has to be conservative enough that a cell never overprints
 * its neighbour, so a slight overestimate is the safe direction to be wrong in.
 */
const AVG_CHAR_WIDTH = 0.52;

function textWidth(text: string, size: number): number {
  return text.length * size * AVG_CHAR_WIDTH;
}

/**
 * WinAnsi code points the 14 standard PDF fonts can draw.
 *
 * `pdf-lib` throws on `drawText` for anything outside this set, so an employee whose
 * name carries a macron would otherwise fail the entire report. Folding the diacritic
 * away loses a mark; throwing loses the document.
 */
const WIN_ANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

function isWinAnsi(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return WIN_ANSI_HIGH.has(codePoint);
}

export function sanitiseWinAnsi(input: string): string {
  let out = "";

  for (const char of input.replace(/[\r\n\t]+/g, " ")) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isWinAnsi(codePoint)) {
      out += char;
      continue;
    }

    // Strip combining marks and keep the base letter when there is one: "ā" -> "a".
    const folded = char.normalize("NFD").replace(/\p{M}/gu, "");
    const drawable =
      folded.length > 0 &&
      [...folded].every((c) => {
        const cp = c.codePointAt(0);
        return cp !== undefined && isWinAnsi(cp);
      });

    out += drawable ? folded : "?";
  }

  return out;
}

/** Trims text to a width, marking the cut so a reader knows something was dropped. */
function fit(text: string, size: number, maxWidth: number): string {
  if (textWidth(text, size) <= maxWidth) return text;

  const ellipsis = "...";
  const budget = Math.max(0, maxWidth - textWidth(ellipsis, size));
  const keep = Math.max(0, Math.floor(budget / (size * AVG_CHAR_WIDTH)));
  return text.slice(0, keep) + ellipsis;
}

export function planPdf(document: ReportDocument, options: PdfOptions = {}): PdfPlan {
  const size = PAGE_SIZES[options.pageSize ?? "a4"];
  // Landscape by default: these tables are wide and a squeezed column is unreadable.
  const landscape = (options.orientation ?? "landscape") === "landscape";
  const pageWidth = landscape ? size.height : size.width;
  const pageHeight = landscape ? size.width : size.height;

  const pages: PdfPage[] = [];
  let page: PdfPage = { texts: [], lines: [] };
  let cursor = pageHeight - MARGIN;
  let first = true;

  const newPage = (): void => {
    pages.push(page);
    page = { texts: [], lines: [] };
    cursor = pageHeight - MARGIN;
  };

  const write = (text: string, x: number, size_: number, bold: boolean, grey = 0): void => {
    page.texts.push({ text: sanitiseWinAnsi(text), x, y: cursor, size: size_, bold, grey });
  };

  // Document header.
  write(document.title, MARGIN, TITLE_SIZE, true);
  cursor -= TITLE_SIZE + 4;
  if (document.subtitle) {
    write(document.subtitle, MARGIN, META_SIZE, false, 0.4);
    cursor -= META_SIZE + 4;
  }
  write(
    `${document.periodStart} to ${document.periodEnd} — generated ${document.generatedAt}`,
    MARGIN,
    META_SIZE,
    false,
    0.4,
  );
  cursor -= META_SIZE + 4;
  for (const note of document.notes) {
    write(note, MARGIN, META_SIZE, false, 0.4);
    cursor -= META_SIZE + 3;
  }
  cursor -= 6;

  for (const section of document.sections) {
    const widths = columnWidths(section, pageWidth - MARGIN * 2, document.decimalDuration);
    const bottom = MARGIN + ROW_HEIGHT * 2;

    const drawHeader = (): void => {
      write(section.heading, MARGIN, HEADER_SIZE + 2, true);
      cursor -= HEADER_SIZE + 8;

      let x = MARGIN;
      section.columns.forEach((column, index) => {
        const width = widths[index] ?? 0;
        write(fit(column.label, HEADER_SIZE, width), x, HEADER_SIZE, true);
        x += width + COLUMN_GAP;
      });
      cursor -= 4;
      page.lines.push({
        x1: MARGIN,
        y1: cursor,
        x2: pageWidth - MARGIN,
        y2: cursor,
        width: 0.6,
        grey: 0.7,
      });
      cursor -= ROW_HEIGHT - 4;
    };

    if (!first) newPage();
    first = false;
    drawHeader();

    const drawRow = (record: ReportRow, bold: boolean): void => {
      if (cursor < bottom) {
        newPage();
        drawHeader();
      }

      let x = MARGIN;
      section.columns.forEach((column, index) => {
        const width = widths[index] ?? 0;
        const text = formatCell(
          record.cells[column.id] ?? null,
          effectiveFormat(column.format, document.decimalDuration),
        );
        const fitted = fit(sanitiseWinAnsi(text), BODY_SIZE, width);
        const offset = column.align === "right" ? width - textWidth(fitted, BODY_SIZE) : 0;
        write(fitted, x + Math.max(0, offset), BODY_SIZE, bold);
        x += width + COLUMN_GAP;
      });
      cursor -= ROW_HEIGHT;
    };

    for (const record of section.rows) drawRow(record, false);

    if (section.totals) {
      if (cursor < bottom) {
        newPage();
        drawHeader();
      }
      page.lines.push({
        x1: MARGIN,
        y1: cursor + ROW_HEIGHT - 4,
        x2: pageWidth - MARGIN,
        y2: cursor + ROW_HEIGHT - 4,
        width: 0.6,
        grey: 0.7,
      });
      drawRow(section.totals, true);
    }
  }

  pages.push(page);
  return { pageWidth, pageHeight, pages };
}

/**
 * Splits the available width between columns.
 *
 * Weighted by the widest text each column actually contains, so a `Duration` column
 * does not get the same slice as a window title. Bounded below so a column never
 * collapses to nothing.
 */
function columnWidths(section: ReportSection, available: number, decimalDuration: boolean): number[] {
  const demands = section.columns.map((column) => {
    let widest = textWidth(column.label, HEADER_SIZE);
    const format = effectiveFormat(column.format, decimalDuration);

    for (const record of [...section.rows, ...(section.totals ? [section.totals] : [])]) {
      const text = sanitiseWinAnsi(formatCell(record.cells[column.id] ?? null, format));
      widest = Math.max(widest, textWidth(text, BODY_SIZE));
    }

    return Math.max(24, widest);
  });

  const gaps = COLUMN_GAP * Math.max(0, section.columns.length - 1);
  const usable = Math.max(1, available - gaps);
  const total = demands.reduce((sum, d) => sum + d, 0);

  if (total <= usable) return demands;
  return demands.map((d) => (d / total) * usable);
}
