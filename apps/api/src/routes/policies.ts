import type { Json } from "@aems/types";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";

/**
 * The monitoring policy a company is currently operating under.
 *
 * **Everyone signed in may read this, employees included, and that is deliberate.**
 * The policy states the screenshot interval and the idle threshold — the terms a
 * person is being monitored under. `docs/design.md` puts "Company Policy — Active" on
 * the Android home screen for the same reason. A monitoring product that hides its own
 * policy from the people it monitors is the surveillance framing the design direction
 * rules out.
 *
 * Writing one is super-admin only, and it **appends a version** rather than editing
 * the row in place — see {@link policyDraftSchema} and the POST handler below.
 */

/**
 * The five intervals `docs/scope.md` §2.3 names, in seconds. Not a free-text number.
 *
 * The column check is only `>= 30`, so the database would happily take 47 seconds.
 * The scope document lists exactly five options and the dashboard's settings screen
 * offers exactly those five; accepting a sixth here means the API can hold a value no
 * screen can display or round-trip.
 */
export const SCREENSHOT_INTERVAL_SECONDS = [60, 300, 600, 900, 1800] as const;

const INTERVALS = new Set<number>(SCREENSHOT_INTERVAL_SECONDS);

/**
 * A proposed policy. `version` is optional: omit it and the server derives the next
 * one, which is what the dashboard does — an admin should be choosing a screenshot
 * interval, not inventing a version string.
 */
export const policyDraftSchema = z.object({
  name: z.string().min(1).max(160),
  screenshotIntervalSeconds: z
    .number()
    .int()
    .refine((n) => INTERVALS.has(n), {
      message: `screenshotIntervalSeconds must be one of ${SCREENSHOT_INTERVAL_SECONDS.join(", ")}`,
    }),
  // The column check is `>= 30`. The upper bound is ours: an idle threshold of a day
  // is not a policy, it is idle detection switched off while still looking enabled.
  idleThresholdSeconds: z.number().int().min(30).max(3600),
  trackedCategories: z.array(z.string().min(1).max(60)).max(50).default([]),
  // Accepted so an admin can mirror an externally agreed version label. Constrained
  // because it is quoted back in consent records and audit metadata.
  version: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "version may contain letters, digits, dot, dash and underscore")
    .optional(),
});

export type PolicyDraft = z.infer<typeof policyDraftSchema>;

/**
 * Derives the next version label in the `YYYY.MM.N` scheme the seed established
 * (`2026.08.1`).
 *
 * Only versions already in this month's series are considered, and the largest
 * numeric suffix wins rather than the count — deleting or hand-writing a row must not
 * make the next mint collide with a version consent has already been recorded against.
 * Anything not in the scheme (an admin's hand-picked label) is ignored rather than
 * being parsed into a number, because `Number("2026.08.beta")` is `NaN` and `NaN`
 * quietly compares false against every bound.
 */
export function nextPolicyVersion(existing: readonly string[], now: Date): string {
  const prefix = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.`;

  let highest = 0;
  for (const version of existing) {
    if (!version.startsWith(prefix)) continue;
    const suffix = version.slice(prefix.length);
    // `Number("")` is 0 and `Number(" 1")` is 1; require plain digits so neither
    // becomes a version number.
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (n > highest) highest = n;
  }

  return `${prefix}${highest + 1}`;
}

export const policyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/current", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    // Newest by `created_at` — the SAME rule `routes/devices.ts` uses when it tells an
    // enrolling agent which policy to enforce. If these two ever disagree, the settings
    // screen shows one policy while the agents run another, which in a compliance
    // product is worse than showing nothing. Changing the rule means changing both.
    const { data } = await app.supabase
      .from("policies")
      .select("*")
      .eq("company_id", session.companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // `null`, not 404: "this company has not published a policy" is a real answer about
    // an existing company, and the dashboard renders it as the setup prompt.
    return data ?? null;
  });

  /**
   * Publishes a policy.
   *
   * **This inserts a new version. It never updates one.** Consent is recorded against
   * a `policy_version` string, so editing a live policy in place would leave every
   * existing `consent_records` row pointing at a version whose terms have silently
   * changed underneath it — the employee agreed to a 15-minute screenshot interval and
   * is now on a 1-minute one, with nothing in the record showing the difference. The
   * schema comment on `public.policies` says the same thing; this is that rule in code.
   *
   * It is also the route that unblocks a fresh tenant: without a policy row,
   * `POST /api/devices/enroll` answers 409 `no_policy` forever and the only way out was
   * hand-written SQL.
   */
  app.post("/", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const parsed = policyDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const draft = parsed.data;

    // Every version this company has ever published. Company-scoped: the service-role
    // key bypasses RLS, so this filter is the whole tenant boundary.
    const { data: existing, error: readError } = await app.supabase
      .from("policies")
      .select("version, created_at")
      .eq("company_id", session.companyId)
      .order("created_at", { ascending: false });

    if (readError) {
      return reply
        .code(500)
        .send({ error: "policy_read_failed", message: readError.message, statusCode: 500 });
    }

    const versions = (existing ?? []).map((row) => row.version);
    const previousVersion = versions[0] ?? null;
    const version = draft.version ?? nextPolicyVersion(versions, new Date());

    // Checked before the insert so the caller gets "that version already exists"
    // instead of a driver's unique-violation text. The database index is still the
    // authority — see the error branch below, which catches the race.
    if (versions.includes(version)) {
      return reply.code(409).send({
        error: "version_exists",
        message: `Policy version ${version} already exists. Publish a new version instead of reusing one.`,
        statusCode: 409,
      });
    }

    const { data: policy, error } = await app.supabase
      .from("policies")
      .insert({
        company_id: session.companyId,
        version,
        name: draft.name,
        screenshot_interval_seconds: draft.screenshotIntervalSeconds,
        idle_threshold_seconds: draft.idleThresholdSeconds,
        tracked_categories: draft.trackedCategories,
      })
      .select("*")
      .single();

    if (error || !policy) {
      // 23505 is Postgres' unique violation: two admins published at the same instant
      // and the other one won. A retry mints the next number, so this is a 409.
      const conflict = error?.code === "23505";
      return reply.code(conflict ? 409 : 500).send({
        error: conflict ? "version_exists" : "policy_write_failed",
        message: conflict
          ? `Policy version ${version} already exists. Publish a new version instead of reusing one.`
          : (error?.message ?? "Could not publish policy"),
        statusCode: conflict ? 409 : 500,
      });
    }

    // A policy change alters what every agent on the estate collects. It is one of the
    // few writes where the previous value matters as much as the new one, so both
    // versions go into the append-only trail.
    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "policy.published",
        targetType: "policy",
        targetId: policy.id,
        metadata: {
          version,
          previousVersion,
          name: draft.name,
          screenshotIntervalSeconds: draft.screenshotIntervalSeconds,
          idleThresholdSeconds: draft.idleThresholdSeconds,
          trackedCategories: draft.trackedCategories,
        } as Json,
      },
      app.log,
    );

    return reply.code(201).send(policy);
  });
};
