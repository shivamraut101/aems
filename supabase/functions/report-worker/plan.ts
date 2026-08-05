/**
 * The page-plan wire shape.
 *
 * Structurally identical to `PdfPlan` in `packages/analytics/src/reports/pdf-layout.ts`,
 * which is where it is produced and unit-tested. It is redeclared rather than imported
 * because Edge Functions are bundled from `supabase/functions` alone and cannot reach
 * into the pnpm workspace — but note that nothing here is *computed* twice: these are
 * type declarations with no arithmetic, so there is no second implementation to drift.
 */

export interface PdfTextRun {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
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

/** What `GET /api/reports/:id/render` answers with. Exactly one body field is set. */
export interface RenderResponse {
  storagePath: string;
  filename: string;
  contentType: string;
  format: "csv" | "pdf";
  rowCount: number;
  csv: string | null;
  plan: PdfPlan | null;
}
