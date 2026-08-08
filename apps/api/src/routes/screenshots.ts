import { canViewOthers } from "@aems/auth";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_SCREENSHOT_BLOCK_SECONDS,
  groupScreenshotsIntoBlocks,
  signablePaths,
  signedUrlIndex,
  withSignedUrls,
} from "@aems/analytics";
import { AEMS_BUCKET, screenshotPath } from "@aems/supabase";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { collectionDenial, resolveCollection } from "../plugins/context.js";
import { validationFailure } from "../lib/validation.js";
import { profileVisibilityDenial } from "../lib/visibility.js";

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

/**
 * The block widths a caller may ask for.
 *
 * A closed set rather than a free number, so the screenshot strip, the timeline
 * ribbon and the app list cannot end up on three grids that nearly agree. 600 is the
 * shared unit; the others exist for a zoomed-in review and a whole-day strip.
 */
const BLOCK_SECONDS = [60, 300, 600, 1800, 3600] as const;

/**
 * Blocks one request may span.
 *
 * A window is rendered whole — empty blocks included, because a gap in the day is
 * information — so an unbounded range would build a response nobody can read. 500
 * covers three days at the shared unit and a full working day at the finest one.
 * Refused explicitly rather than silently clipped: a half-answer about somebody's
 * working day is worse than a clear "narrow the range".
 */
const MAX_BLOCKS_PER_REQUEST = 500;

const blocksQuerySchema = z.object({
  profileId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  blockSeconds: z.coerce
    .number()
    .int()
    .refine((value) => (BLOCK_SECONDS as readonly number[]).includes(value), {
      message: `blockSeconds must be one of ${BLOCK_SECONDS.join(", ")}`,
    })
    .default(DEFAULT_SCREENSHOT_BLOCK_SECONDS),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * Lifetime of a signed screenshot URL.
 *
 * A signed URL is a bearer capability for the most sensitive artefact in the
 * product, and it outlives the page in browser history. Ten minutes is long enough
 * to read a review page and open a few lightboxes, short enough that a leaked link
 * is dead before it is useful — and TanStack Query re-signs on refetch, so a page
 * left open recovers rather than breaking.
 */
export const SIGNED_URL_TTL_SECONDS = 60 * 10;

/** Everything the review path renders, and nothing else. */
const READ_COLUMNS = "id, captured_at, storage_path, thumbnail_path, blurred, work_session_id";

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

    const consent = await resolveCollection(app.supabase, device);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    // Answered before the multipart body is read: a refused frame must not cost the
    // agent an upload, and reading it first would mean it did.
    if (!consent.types.has("screenshots")) {
      return reply.code(403).send(collectionDenial("screenshots"));
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
        .send(validationFailure(parsed.error, "invalid_body"));
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
        .send(validationFailure(parsed.error, "invalid_query"));
    }

    const session = request.session!;
    const { profileId, from, to, limit } = parsed.data;

    const denial = await profileVisibilityDenial(app, session, profileId);
    if (denial) return reply.code(denial.statusCode).send({ ...denial });

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

    // One signing call for the page. Both keys of a row go in the same batch so the
    // lightbox does not need a second round trip after the thumbnail is on screen.
    const paths = new Set<string>();
    for (const row of rows) {
      paths.add(row.storage_path);
      if (row.thumbnail_path) paths.add(row.thumbnail_path);
    }

    const { data: signed } = await app.supabase.storage
      .from(AEMS_BUCKET)
      .createSignedUrls([...paths], SIGNED_URL_TTL_SECONDS);

    const urlByPath = signedUrlIndex(signed ?? []);

    return rows.map((row) => {
      const signedUrl = urlByPath.get(row.storage_path) ?? null;
      return {
        ...row,
        signedUrl,
        // Nothing writes `thumbnail_path` yet; the full image keeps a tile
        // renderable until the agent starts uploading thumbnails.
        thumbnailUrl: (row.thumbnail_path ? urlByPath.get(row.thumbnail_path) : null) ?? signedUrl,
      };
    });
  });

  /**
   * Screenshots grouped into the fixed block the timeline uses — the review screen.
   *
   * Same window and the same `blockSeconds` as `GET /api/analytics/timeline` yields
   * the same block boundaries, because both slice the window with one rule. That is
   * what lets a manager read a block's activity split and its captures as one row
   * instead of two views that nearly line up.
   *
   * Blocks with no capture are returned, not dropped: "nothing was captured between
   * 11:20 and 11:30" is a fact the reviewer needs to see.
   */
  app.get("/blocks", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = blocksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_query"));
    }

    const session = request.session!;
    const { profileId, from, to, blockSeconds, limit } = parsed.data;

    // Identical to the gate on the list route above: an employee reads their own
    // record and nobody else's, and every query is scoped to the caller's company.
    // RLS is the boundary; this is the UI-facing half of the same rule.
    const denial = await profileVisibilityDenial(app, session, profileId);
    if (denial) return reply.code(denial.statusCode).send({ ...denial });

    const windowMs = Date.parse(to) - Date.parse(from);
    if (windowMs <= 0) {
      return reply.code(400).send({
        error: "invalid_range",
        message: "`to` must be after `from`",
        statusCode: 400,
      });
    }

    if (Math.ceil(windowMs / (blockSeconds * 1000)) > MAX_BLOCKS_PER_REQUEST) {
      return reply.code(400).send({
        error: "range_too_wide",
        message: `That range is more than ${MAX_BLOCKS_PER_REQUEST} blocks. Narrow the range or ask for a wider block.`,
        statusCode: 400,
      });
    }

    const { data: rows } = await app.supabase
      .from("screenshots")
      .select(READ_COLUMNS)
      .eq("company_id", session.companyId)
      .eq("profile_id", profileId)
      .gte("captured_at", from)
      .lte("captured_at", to)
      // Ascending, so a truncated page is the *start* of the window the caller asked
      // for rather than an arbitrary tail. `truncated` says so out loud.
      .order("captured_at", { ascending: true })
      .limit(limit);

    const blocks = groupScreenshotsIntoBlocks({
      periodStart: from,
      periodEnd: to,
      blockSeconds,
      screenshots: rows ?? [],
    });

    const paths = signablePaths(blocks);
    const { data: signed } = paths.length
      ? await app.supabase.storage.from(AEMS_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      : { data: [] };

    return {
      profileId,
      from,
      to,
      blockSeconds,
      screenshotCount: rows?.length ?? 0,
      truncated: (rows?.length ?? 0) >= limit,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      blocks: withSignedUrls(blocks, signedUrlIndex(signed ?? [])),
    };
  });
};
