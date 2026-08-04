import type { Database } from "@aems/types";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseAdminEnv, readSupabaseEnv, type SupabaseAdminEnv, type SupabaseEnv } from "./env.js";

export type AemsSupabaseClient = SupabaseClient<Database>;

/**
 * Anon-key client. Every query it runs is subject to RLS, so this is what the
 * dashboard and any user-facing surface should use.
 */
export function createAnonClient(env: SupabaseEnv = readSupabaseEnv()): AemsSupabaseClient {
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false },
  });
}

/**
 * Service-role client. Bypasses RLS.
 *
 * Only the Fastify API and Edge Functions may construct this, and every query made
 * through it must filter by company_id by hand — the database will not do it for
 * you here. Treat a missing company_id filter in service-role code as a tenant leak.
 */
export function createAdminClient(env: SupabaseAdminEnv = readSupabaseAdminEnv()): AemsSupabaseClient {
  return createClient<Database>(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Client bound to one end user's access token. Runs as `authenticated`, so RLS
 * applies with that person's company and role.
 */
export function createUserClient(
  accessToken: string,
  env: SupabaseEnv = readSupabaseEnv(),
): AemsSupabaseClient {
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
