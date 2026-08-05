import fs from "node:fs";
import path from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// pnpm runs a workspace script with cwd set to that package, so dotenv's default
// `<cwd>/.env` resolves to apps/api/.env and never finds the repo-root file the
// dashboard, the agents and the Edge Functions all share. Walk up instead.
//
// Nearest wins: dotenv keeps the first value it sees for a key, so loading from
// the innermost directory outward lets a package-local .env override the root.
function loadEnvFiles(from: string = process.cwd()): void {
  let dir = from;

  for (;;) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) loadDotenv({ path: candidate });

    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
}

loadEnvFiles();

const schema = z.object({
  API_PORT: z.coerce.number().default(3001),
  API_HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DEVICE_TOKEN_SECRET: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid API environment:\n${missing}\n\nSee .env.example.`);
  }

  return parsed.data;
}
