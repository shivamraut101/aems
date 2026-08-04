/** Environment plumbing shared by every Supabase client factory. */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

export interface SupabaseAdminEnv extends SupabaseEnv {
  serviceRoleKey: string;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your Supabase project settings.`,
    );
  }
  return value;
}

/** Public config. Safe to expose to browsers and agent binaries. */
export function readSupabaseEnv(source: Record<string, string | undefined> = process.env): SupabaseEnv {
  return {
    url: required("SUPABASE_URL", source["SUPABASE_URL"] ?? source["NEXT_PUBLIC_SUPABASE_URL"]),
    anonKey: required(
      "SUPABASE_ANON_KEY",
      source["SUPABASE_ANON_KEY"] ?? source["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    ),
  };
}

/**
 * Server-only config.
 *
 * The service role key bypasses RLS entirely. It belongs in the Fastify API and in
 * Edge Functions — never in the dashboard bundle, never in an agent binary.
 */
export function readSupabaseAdminEnv(
  source: Record<string, string | undefined> = process.env,
): SupabaseAdminEnv {
  return {
    ...readSupabaseEnv(source),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", source["SUPABASE_SERVICE_ROLE_KEY"]),
  };
}
