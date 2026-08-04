import { PrismaClient } from "../generated/client/index.js";

declare global {
  // eslint-disable-next-line no-var
  var __aemsPrisma: PrismaClient | undefined;
}

/** Reuse a single PrismaClient across hot reloads / lambda invocations. */
export const prisma = globalThis.__aemsPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__aemsPrisma = prisma;
}

export * from "../generated/client/index.js";
