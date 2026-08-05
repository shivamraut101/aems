// Deno runtime. `pdf-lib` is the deliberate choice over `pdfkit`: pdfkit reads its
// AFM font files off disk at import time and trips a blocklisted `Deno.readFileSync`
// in the Edge runtime, while pdf-lib ships the 14 standard fonts inside the package
// and is tested against Deno.
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

import type { PdfPlan } from "./plan.ts";

/**
 * Draws a page plan.
 *
 * Deliberately dumb: every number here was decided by `planPdf` in
 * `packages/analytics`, which is unit-tested without a PDF library in the room.
 * This file owns nothing but the drawing calls, so the one piece that cannot be
 * tested in the workspace is also the one piece with no logic in it.
 */
export async function renderPdf(plan: PdfPlan): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const page of plan.pages) {
    const drawn = pdf.addPage([plan.pageWidth, plan.pageHeight]);

    for (const line of page.lines) {
      drawn.drawLine({
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        thickness: line.width,
        color: rgb(line.grey, line.grey, line.grey),
      });
    }

    for (const text of page.texts) {
      if (text.text.length === 0) continue;
      drawn.drawText(text.text, {
        x: text.x,
        y: text.y,
        size: text.size,
        font: text.bold ? bold : regular,
        color: rgb(text.grey, text.grey, text.grey),
      });
    }
  }

  return await pdf.save();
}
