import type { Database } from "@aems/types";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

import { specRequestInit, specResult, type ApiQuerySpec } from "./query-spec";
import { apiBaseUrl, joinUrl, parseMeResponse, type Session } from "./session";

/**
 * `@supabase/ssr` types `cookies` as a union of the current and the deprecated
 * shape, which defeats inference on the `setAll` callback. Naming the parameter
 * type restores it without reaching into the library's internals.
 */
type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Server-side Supabase client, backed by the request's cookie jar.
 *
 * Cookie-based rather than localStorage-based so one session is visible to the
 * browser, to middleware and to server components at once — that is the whole
 * reason `@supabase/ssr` exists, and it is what lets middleware protect a route
 * before any page code runs.
 *
 * Business reads do NOT go through this client. It exists to establish who the
 * caller is; everything else goes to the Fastify API. See `serverApiFetch`.
 */
export async function createServerSupabase() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local.",
    );
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components may not write cookies. Harmless: middleware runs the
          // refresh on every request and writes the rotated tokens there.
        }
      },
    },
  });
}

/**
 * The access token to present to the Fastify API, refreshed if it had expired.
 *
 * `getSession()` rather than `getUser()` because the token itself is what we need.
 * Authenticity is not being asserted here — the API verifies the token against
 * Supabase Auth on every request (`packages/auth/src/session.ts`).
 */
export async function getAccessToken(): Promise<string | null> {
  const supabase = await createServerSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.access_token ?? null;
}

/**
 * Calls the Fastify API from a Server Component or Route Handler.
 *
 * Returns null when there is no session or the API refuses, because a server render
 * has one sensible response to either — render the signed-out path and let middleware
 * do the redirecting. Client components want the error taxonomy instead; they use
 * `apiFetch` from `./api`.
 */
export async function serverApiFetch<T>(path: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const response = await fetch(joinUrl(apiBaseUrl(), path), {
      headers: { Authorization: `Bearer ${token}` },
      // Monitoring data ages fast and identity must not be served from a shared
      // cache across users.
      cache: "no-store",
    });

    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Runs one {@link ApiQuerySpec} server-side, and **throws** when it does not answer.
 *
 * Throwing is the whole point, and it is the opposite of {@link serverApiFetch}'s
 * contract on purpose. `prefetchQuery` caches whatever the function returns, so a
 * fetcher that answers `null` on a 500 would dehydrate `null` as though the API had
 * said "nothing here" — and the browser would render an empty state for an outage
 * and never retry, because the cache looks satisfied. A throw leaves the entry
 * absent, the client fetches it normally, and a real failure reaches the real error
 * state.
 *
 * Server-only: it reads the request's cookie jar. Importing it from a `"use client"`
 * module is a build error, which is the intended guard rail.
 */
export async function serverApiQuery<T>(spec: ApiQuerySpec<T>): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error(`No server session; cannot prefetch ${spec.path}`);

  const init = specRequestInit(spec);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(joinUrl(apiBaseUrl(), spec.path), {
    ...init,
    headers,
    // Monitoring data ages fast, and identity must never be served to one employee
    // out of a cache warmed by another.
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`${spec.path} answered ${String(response.status)}`);
  }

  return specResult(spec, response.status === 204 ? undefined : await response.json());
}

/**
 * The signed-in person, server-side.
 *
 * Wrapped in React's `cache` so a layout and three server components asking in the
 * same render make one call rather than four.
 */
export const getServerSession = cache(async (): Promise<Session | null> => {
  const payload = await serverApiFetch<unknown>("/api/auth/me");
  return payload === null ? null : parseMeResponse(payload);
});
