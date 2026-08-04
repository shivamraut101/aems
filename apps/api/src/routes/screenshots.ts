import { randomUUID } from "node:crypto";

import { AEMS_BUCKET, screenshotPath } from "@aems/supabase";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { assertConsent } from "../plugins/context.js";

const metadataSchema = z.object({
  clientEventId: z.string().uuid(),
  capturedAt: z.string().datetime({ offset: true }),
  blurred: z.coerce.boolean().default(false),
  workSessionId: z.coerce.number().int().nullish(),
});

const listQuerySchema = z.object({
  profileId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ALLOWED_MIME = new Set(["image/webp", "image/png", "image/jpeg"]);

export const screenshotRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Screenshot upload — multipart, binary to Storage and a metadata row to Postgres.
   *
   * The binary is written first. A stored object with no row is invisible clutter we
   * can sweep up; a row pointing at an object that was never written is a broken
   * image in the timeline, which is worse.
   */
  app.post("/", { preHandler: app.requireDevice }, async (request, reply) => {
    const device = request.device!;

    const consent = await assertConsent(app.supabase, device.deviceId);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const file = await request.file();
    if (!file) {
      return reply
        .code(400)
        .send({ error: "missing_file", message: "Expected a multipart file field", statusCode: 400 });
    }

    if (!ALLOWED_MIME.has(file.mimetype)) {
      return reply.code(415).send({
        error: "unsupported_media_type",
        message: `${file.mimetype} is not an accepted screenshot format`,
        statusCode: 415,
      });
    }

    // @fastify/multipart exposes sibling text fields on the file part.
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const parsed = metadataSchema.safeParse({
      clientEventId: fields["clientEventId"]?.value,
      capturedAt: fields["capturedAt"]?.value,
      blurred: fields["blurred"]?.value ?? false,
      workSessionId: fields["workSessionId"]?.value ?? null,
    });

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const meta = parsed.data;
    const buffer = await file.toBuffer();
    const extension = file.mimetype.split("/")[1] ?? "webp";
    const filename = `${meta.capturedAt.replace(/[:.]/g, "-")}-${randomUUID()}.${extension}`;
    const path = screenshotPath(device.companyId, device.profileId, filename);

    const { error: uploadError } = await app.supabase.storage
      .from(AEMS_BUCKET)
      .upload(path, buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      return reply
        .code(500)
        .send({ error: "upload_failed", message: uploadError.message, statusCode: 500 });
    }

    const { data, error } = await app.supabase
      .from("screenshots")
      .upsert(
        {
          company_id: device.companyId,
          profile_id: device.profileId,
          device_id: device.deviceId,
          work_session_id: meta.workSessionId ?? null,
          captured_at: meta.capturedAt,
          storage_path: path,
          blurred: meta.blurred,
          client_event_id: meta.clientEventId,
        },
        { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (error) {
      // Roll the object back so a failed insert does not leave an orphan behind.
      await app.supabase.storage.from(AEMS_BUCKET).remove([path]);
      return reply
        .code(500)
        .send({ error: "metadata_failed", message: error.message, statusCode: 500 });
    }

    // No row returned means this clientEventId was already stored — a retry.
    if (!data) {
      await app.supabase.storage.from(AEMS_BUCKET).remove([path]);
      return { duplicate: true as const };
    }

    return { screenshotId: data.id };
  });

  /**
   * Screenshots for one person over a window, each with a short-lived signed URL.
   *
   * The bucket is private, so the dashboard cannot link to objects directly.
   */
  app.get("/", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { profileId, from, to, limit } = parsed.data;

    if (profileId !== session.profileId && session.role === "employee") {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Not your data", statusCode: 403 });
    }

    const { data: rows } = await app.supabase
      .from("screenshots")
      .select("*")
      .eq("company_id", session.companyId)
      .eq("profile_id", profileId)
      .gte("captured_at", from)
      .lte("captured_at", to)
      .order("captured_at", { ascending: false })
      .limit(limit);

    if (!rows?.length) return [];

    const { data: signed } = await app.supabase.storage
      .from(AEMS_BUCKET)
      .createSignedUrls(
        rows.map((row) => row.storage_path),
        60 * 10,
      );

    const urlByPath = new Map((signed ?? []).map((entry) => [entry.path, entry.signedUrl]));

    return rows.map((row) => ({
      ...row,
      signedUrl: urlByPath.get(row.storage_path) ?? null,
    }));
  });
};
