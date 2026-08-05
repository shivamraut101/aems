import { adminClient, authorize, json } from "../_shared/client.ts";
import { renderPdf } from "./pdf.ts";
import type { RenderResponse } from "./plan.ts";

/** One drain does a bounded amount of work; the schedule comes back in two minutes. */
const BATCH_SIZE = 10;

/** A report that cannot render in this long is not going to. */
const RENDER_TIMEOUT_MS = 60_000;

/**
 * Report worker.
 *
 * Picks up rows the API queued as `pending`, asks the API for the rendered document,
 * writes the file, and flips the row to `ready`. A row that throws is marked `failed`
 * with the reason recorded on the row, so a broken report never looks like a slow one
 * and the cause does not live only in this function's log.
 *
 * It deliberately computes nothing. The previous version re-implemented the interval
 * merge by hand and got four things wrong that the dashboard got right — idle was
 * never subtracted, the window end was a null fallback rather than a cap, events
 * overlapping the start of the window were dropped, and each application's spans were
 * merged independently so one person on two devices produced a day longer than a day.
 * Two implementations of the same arithmetic is how that happens; there is now one,
 * in `packages/analytics`, behind `GET /api/reports/:id/render`.
 */
Deno.serve(async (request: Request) => {
  const denied = authorize(request);
  if (denied) return denied;

  const apiUrl = Deno.env.get("AEMS_API_URL");
  const workerSecret = Deno.env.get("WORKER_SECRET");

  if (!apiUrl || !workerSecret) {
    return json(
      { error: "AEMS_API_URL and WORKER_SECRET must be set for the report worker" },
      500,
    );
  }

  const supabase = adminClient();

  const { data: queued, error } = await supabase
    .from("reports")
    // Only the id: everything else about the report — format, grouping, scope —
    // is resolved by the API when it renders. The worker never interprets a spec.
    .select("id")
    .eq("status", "pending")
    .order("created_at")
    .limit(BATCH_SIZE);

  if (error) return json({ error: error.message }, 500);

  const results: { id: number; status: string }[] = [];

  for (const report of queued ?? []) {
    try {
      const rendered = await fetchRendered(apiUrl, workerSecret, report.id);
      const body = await serialise(rendered);

      const { error: uploadError } = await supabase.storage
        .from("aems")
        .upload(rendered.storagePath, body, {
          contentType: rendered.contentType,
          upsert: true,
        });

      if (uploadError) throw uploadError;

      await supabase
        .from("reports")
        .update({
          status: "ready",
          storage_path: rendered.storagePath,
          row_count: rendered.rowCount,
          failure_reason: null,
        })
        .eq("id", report.id);

      results.push({ id: report.id, status: "ready" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await supabase
        .from("reports")
        // Truncated: this is surfaced to a manager, not a log sink.
        .update({ status: "failed", failure_reason: reason.slice(0, 500) })
        .eq("id", report.id);
      results.push({ id: report.id, status: `failed: ${reason}` });
    }
  }

  return json({ processed: results });
});

async function fetchRendered(
  apiUrl: string,
  secret: string,
  reportId: number,
): Promise<RenderResponse> {
  // A hung API must not hold the whole drain open; the next run retries the row.
  const abort = AbortSignal.timeout(RENDER_TIMEOUT_MS);

  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/reports/${reportId}/render`, {
    headers: { "x-worker-secret": secret },
    signal: abort,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Render failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  return (await response.json()) as RenderResponse;
}

async function serialise(rendered: RenderResponse): Promise<Blob> {
  if (rendered.format === "pdf") {
    if (!rendered.plan) throw new Error("PDF report arrived without a page plan");
    const bytes = await renderPdf(rendered.plan);
    return new Blob([bytes], { type: "application/pdf" });
  }

  if (rendered.csv === null) throw new Error("CSV report arrived without a body");
  // The BOM and CRLF are already in the string; encoding it as UTF-8 preserves both.
  return new Blob([rendered.csv], { type: "text/csv;charset=utf-8" });
}
