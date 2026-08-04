import { AEMS_BUCKET } from "@aems/supabase";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const createSchema = z.object({
  kind: z.enum(["daily", "weekly", "team"]),
  profileId: z.string().uuid().nullish(),
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
});

export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    let query = app.supabase
      .from("reports")
      .select("*")
      .eq("company_id", session.companyId)
      .order("period_start", { ascending: false });

    if (session.role === "employee") {
      query = query.eq("profile_id", session.profileId);
    }

    const { data } = await query;
    return data ?? [];
  });

  /**
   * Queues a report.
   *
   * The row is created as `pending`; the report Edge Function picks it up, renders
   * it, and flips it to `ready`. Generation is not done inline because a team report
   * over a long window would hold an HTTP connection open for minutes.
   */
  app.post("/", { preHandler: app.requireManager }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const body = parsed.data;

    const { data, error } = await app.supabase
      .from("reports")
      .insert({
        company_id: session.companyId,
        profile_id: body.profileId ?? null,
        kind: body.kind,
        period_start: body.periodStart,
        period_end: body.periodEnd,
        status: "pending",
      })
      .select("*")
      .single();

    if (error || !data) {
      return reply
        .code(500)
        .send({ error: "report_failed", message: error?.message ?? "Could not queue report", statusCode: 500 });
    }

    return data;
  });

  /** Signed download link for a finished report. */
  app.get("/:id/download", { preHandler: app.requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = request.session!;
    const reportId = Number(id);

    if (!Number.isInteger(reportId)) {
      return reply
        .code(400)
        .send({ error: "invalid_id", message: "Report id must be an integer", statusCode: 400 });
    }

    const { data: report } = await app.supabase
      .from("reports")
      .select("*")
      .eq("id", reportId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!report) {
      return reply.code(404).send({ error: "not_found", message: "No such report", statusCode: 404 });
    }

    if (session.role === "employee" && report.profile_id !== session.profileId) {
      return reply.code(403).send({ error: "forbidden", message: "Not your report", statusCode: 403 });
    }

    if (report.status !== "ready" || !report.storage_path) {
      return reply.code(409).send({
        error: "not_ready",
        message: `Report is ${report.status}`,
        statusCode: 409,
      });
    }

    const { data: signed, error } = await app.supabase.storage
      .from(AEMS_BUCKET)
      .createSignedUrl(report.storage_path, 60 * 5);

    if (error || !signed) {
      return reply
        .code(500)
        .send({ error: "sign_failed", message: error?.message ?? "Could not sign URL", statusCode: 500 });
    }

    return { url: signed.signedUrl };
  });
};
