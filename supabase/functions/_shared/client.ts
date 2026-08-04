// Deno runtime — these run in Supabase Edge Functions, not in the pnpm workspace,
// so they import over the network and are excluded from turbo's typecheck.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

/**
 * Service-role client for workers.
 *
 * Workers run with no user attached, so RLS cannot scope them — every query they
 * make must filter by company_id explicitly.
 */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

/** Rejects requests that do not carry the function secret. */
export function authorize(request: Request): Response | null {
  const expected = Deno.env.get("WORKER_SECRET");
  if (!expected) return null;

  const given = request.headers.get("x-worker-secret");
  if (given !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function dayBounds(reference = new Date()): { from: string; to: string } {
  const start = new Date(reference);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}
