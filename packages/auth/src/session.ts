import { createAdminClient, type AemsSupabaseClient } from "@aems/supabase";

import type { SessionProfile } from "./roles.js";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Pulls a bearer token out of an Authorization header. Returns null if absent or malformed. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

/**
 * Verifies a Supabase access token and loads the caller's profile.
 *
 * Verification goes through Supabase Auth rather than decoding the JWT locally, so
 * revoked and expired sessions are actually rejected instead of merely looking
 * well-formed.
 */
export async function resolveSession(
  accessToken: string,
  admin: AemsSupabaseClient = createAdminClient(),
): Promise<SessionProfile> {
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);

  if (userError || !userData.user) {
    throw new AuthError("Invalid or expired session");
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, company_id, email, role")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    // Authenticated with Supabase but never assigned to a company — cannot be
    // authorised for anything, so this is a 403 rather than a 401.
    throw new AuthError("No profile is linked to this account", 403);
  }

  return {
    profileId: profile.id,
    companyId: profile.company_id,
    email: profile.email,
    role: profile.role,
  };
}
