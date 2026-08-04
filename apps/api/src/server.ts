import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type { Env } from "./env.js";
import { contextPlugin } from "./plugins/context.js";
import { activityRoutes } from "./routes/activity.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { authRoutes } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";
import { employeeRoutes } from "./routes/employees.js";
import { reportRoutes } from "./routes/reports.js";
import { screenshotRoutes } from "./routes/screenshots.js";

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      // Screenshots are megabytes of binary; never let one reach the log.
      redact: ["req.headers.authorization", "req.headers['x-device-token']"],
    },
    // Agents can send large screenshot batches.
    bodyLimit: 15 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });

  await app.register(contextPlugin, { env });

  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(employeeRoutes, { prefix: "/api/employees" });
  await app.register(deviceRoutes, { prefix: "/api/devices" });
  await app.register(activityRoutes, { prefix: "/api/activity" });
  await app.register(screenshotRoutes, { prefix: "/api/screenshots" });
  await app.register(reportRoutes, { prefix: "/api/reports" });
  await app.register(analyticsRoutes, { prefix: "/api/analytics" });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error({ err: error }, "unhandled request error");
    const statusCode = error.statusCode ?? 500;

    reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_error" : error.code ?? "request_error",
      // Never leak an internal stack or driver message to a caller.
      message: statusCode === 500 ? "Something went wrong" : error.message,
      statusCode,
    });
  });

  return app;
}
