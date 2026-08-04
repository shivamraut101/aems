"use client";

import type { Database } from "@aems/types";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client.
 *
 * Anon key only — every read it makes is filtered by RLS. Realtime subscriptions
 * come through here; anything that writes goes to the Fastify API instead.
 */
export function createClient() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local.",
    );
  }

  return createBrowserClient<Database>(url, anonKey);
}
