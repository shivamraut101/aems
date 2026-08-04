import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { assertConsent } from "../plugins/context.js";

const activityEventSchema = z.object({
  clientEventId: z.string().uuid(),
  appName: z.string().min(1).max(200),
  windowTitle: z.string().max(500).nullish(),
  url: z.string().max(2000).nullish(),
  domain: z.string().max(253).nullish(),
  category: z.string().max(60).nullish(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullish(),
});

const idleEventSchema = z.object({
  clientEventId: z.string().uuid(),
  idleStartAt: z.string().datetime({ offset: true }),
  idleEndAt: z.string().datetime({ offset: true }).nullish(),
});

const breakEventSchema = z.object({
  clientEventId: z.string().uuid(),
  breakStartAt: z.string().datetime({ offset: true }),
  breakEndAt: z.string().datetime({ offset: true }).nullish(),
});

const batchSchema = z.object({
  deviceId: z.string().uuid(),
  workSessionId: z.number().int().nullish(),
  activity: z.array(activityEventSchema).max(1000).optional(),
  idle: z.array(idleEventSchema).max(1000).optional(),
  breaks: z.array(breakEventSchema).max(1000).optional(),
});

export const activityRoutes: FastifyPluginAsync = async (app) => {
  /** Clock in. The partial unique index on the table makes a second open session impossible. */
  app.post("/sessions", { preHandler: app.requireDevice }, async (request, reply) => {
    const device = request.device!;

    const consent = await assertConsent(app.supabase, device.deviceId);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const { data: existing } = await app.supabase
      .from("work_sessions")
      .select("*")
      .eq("device_id", device.deviceId)
      .is("clock_out_at", null)
      .maybeSingle();

    // Agents restart. Hand back the session already running rather than failing or
    // silently starting a second one.
    if (existing) return existing;

    const { data, error } = await app.supabase
      .from("work_sessions")
      .insert({
        company_id: device.companyId,
        profile_id: device.profileId,
        device_id: device.deviceId,
      })
      .select("*")
      .single();

    if (error || !data) {
      return reply
        .code(500)
        .send({ error: "session_failed", message: error?.message ?? "Could not start session", statusCode: 500 });
    }

    return data;
  });

  /** Clock out. */
  app.post("/sessions/:id/end", { preHandler: app.requireDevice }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = request.device!;
    const sessionId = Number(id);

    if (!Number.isInteger(sessionId)) {
      return reply
        .code(400)
        .send({ error: "invalid_id", message: "Session id must be an integer", statusCode: 400 });
    }

    const { data, error } = await app.supabase
      .from("work_sessions")
      .update({ clock_out_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("device_id", device.deviceId)
      .is("clock_out_at", null)
      .select("*")
      .maybeSingle();

    if (error || !data) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "No open session with that id for this device", statusCode: 404 });
    }

    return data;
  });

  /**
   * Bulk ingestion.
   *
   * Agents buffer while offline and flush on reconnect, so the same batch can arrive
   * more than once. Every row carries a clientEventId with a unique index behind it;
   * `ignoreDuplicates` turns a replay into a no-op instead of a duplicate row.
   */
  app.post("/events", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const device = request.device!;
    const body = parsed.data;

    if (body.deviceId !== device.deviceId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Token does not match device", statusCode: 403 });
    }

    const consent = await assertConsent(app.supabase, device.deviceId);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const base = {
      company_id: device.companyId,
      profile_id: device.profileId,
      device_id: device.deviceId,
    };

    let acceptedActivity = 0;
    let acceptedIdle = 0;
    let acceptedBreaks = 0;

    if (body.activity?.length) {
      const { data, error } = await app.supabase
        .from("activity_events")
        .upsert(
          body.activity.map((event) => ({
            ...base,
            work_session_id: body.workSessionId ?? null,
            app_name: event.appName,
            window_title: event.windowTitle ?? null,
            url: event.url ?? null,
            domain: event.domain ?? null,
            category: event.category ?? null,
            started_at: event.startedAt,
            ended_at: event.endedAt ?? null,
            client_event_id: event.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedActivity = data?.length ?? 0;
    }

    if (body.idle?.length) {
      const { data, error } = await app.supabase
        .from("idle_events")
        .upsert(
          body.idle.map((event) => ({
            ...base,
            idle_start_at: event.idleStartAt,
            idle_end_at: event.idleEndAt ?? null,
            client_event_id: event.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedIdle = data?.length ?? 0;
    }

    if (body.breaks?.length) {
      const { data, error } = await app.supabase
        .from("break_events")
        .upsert(
          body.breaks.map((event) => ({
            ...base,
            work_session_id: body.workSessionId ?? null,
            break_start_at: event.breakStartAt,
            break_end_at: event.breakEndAt ?? null,
            client_event_id: event.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedBreaks = data?.length ?? 0;
    }

    const submitted =
      (body.activity?.length ?? 0) + (body.idle?.length ?? 0) + (body.breaks?.length ?? 0);

    return {
      acceptedActivity,
      acceptedIdle,
      acceptedBreaks,
      duplicates: submitted - acceptedActivity - acceptedIdle - acceptedBreaks,
    };
  });
};
