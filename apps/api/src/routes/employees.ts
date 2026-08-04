import type { Json, TablesUpdate } from "@aems/types";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";

const updateSchema = z.object({
  fullName: z.string().min(1).max(160).optional(),
  department: z.string().max(120).nullish(),
  managerId: z.string().uuid().nullish(),
  role: z.enum(["super_admin", "manager", "employee"]).optional(),
  monitoringEnabled: z.boolean().optional(),
});

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  /** Roster for the dashboard, with each person's current device state attached. */
  app.get("/", { preHandler: app.requireManager }, async (request) => {
    const session = request.session!;

    const { data } = await app.supabase
      .from("profiles")
      .select(
        "id, email, full_name, role, department, manager_id, monitoring_enabled, created_at, devices(id, platform, label, status, last_seen_at)",
      )
      .eq("company_id", session.companyId)
      .order("full_name");

    return data ?? [];
  });

  app.get("/:profileId", { preHandler: app.requireUser }, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const session = request.session!;

    if (profileId !== session.profileId && session.role === "employee") {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Not your profile", statusCode: 403 });
    }

    const { data } = await app.supabase
      .from("profiles")
      .select("*, devices(*)")
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!data) {
      return reply.code(404).send({ error: "not_found", message: "No such employee", statusCode: 404 });
    }

    return data;
  });

  /**
   * Employee management. Super admin only — this is where roles and the monitoring
   * toggle live, so it is the highest-privilege route in the API.
   */
  app.patch("/:profileId", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const parsed = updateSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const body = parsed.data;

    // Demoting yourself could leave a company with no super admin at all.
    if (profileId === session.profileId && body.role && body.role !== "super_admin") {
      return reply.code(400).send({
        error: "cannot_demote_self",
        message: "Ask another super admin to change your role",
        statusCode: 400,
      });
    }

    const patch: TablesUpdate<"profiles"> = {};
    if (body.fullName !== undefined) patch.full_name = body.fullName;
    if (body.department !== undefined) patch.department = body.department;
    if (body.managerId !== undefined) patch.manager_id = body.managerId;
    if (body.role !== undefined) patch.role = body.role;
    if (body.monitoringEnabled !== undefined) patch.monitoring_enabled = body.monitoringEnabled;

    if (Object.keys(patch).length === 0) {
      return reply
        .code(400)
        .send({ error: "empty_patch", message: "Nothing to update", statusCode: 400 });
    }

    const { data, error } = await app.supabase
      .from("profiles")
      .update(patch)
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .select("*")
      .maybeSingle();

    if (error || !data) {
      return reply
        .code(404)
        .send({ error: "not_found", message: error?.message ?? "No such employee", statusCode: 404 });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "employee.updated",
        targetType: "profile",
        targetId: profileId,
        metadata: patch as Json,
      },
      app.log,
    );

    return data;
  });
};
