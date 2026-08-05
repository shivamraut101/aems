/**
 * One API read, described once and answered from both sides of the render.
 *
 * A server prefetch and a client hook only line up if they agree on three things at
 * the same time: the cache key, the URL, and the shape the payload is stored in. Two
 * hand-written copies agree on the day they are written and drift on the day one of
 * them gains a query parameter — and when they drift nothing breaks loudly. The
 * hydrated entry simply sits under a key nobody reads, the hook fetches from scratch,
 * and the page flashes a skeleton exactly as it did before anyone bothered to
 * prefetch. That failure is silent, which is why it is designed out here rather than
 * left to review.
 *
 * So a query is *data*, not a function: `queryKey` and `path` are declared together,
 * once, and the two runtimes each build their own fetch from the same object.
 *
 *   export const devicesQuery = apiQuery<DeviceRow[]>({
 *     queryKey: ["devices"],
 *     path: "/api/devices",
 *   });
 *
 * Read it on the client with `useApiQuery(devicesQuery)` (see `lib/api.ts`) and warm
 * it on the server with `<PrefetchBoundary queries={[devicesQuery]}>` (see
 * `lib/server-query.tsx`). Neither call restates the key or the path.
 *
 * This module is deliberately framework-free — no React, no `next/*`, no Supabase.
 * It is imported by a `"use client"` module and by a server-only one, and anything
 * dragged in here would be dragged into both bundles.
 */

/** The HTTP verbs a *read* is allowed to use. Mutations do not belong in a cache. */
export type ApiQueryMethod = "GET" | "POST";

export interface ApiQuerySpec<T> {
  /**
   * The TanStack cache key. Every value in it must be JSON-serializable, because the
   * server dehydrates the entry and the browser reads it back out of the HTML.
   */
  readonly queryKey: readonly unknown[];
  /** Path on the Fastify API, including any query string — e.g. `/api/devices?x=1`. */
  readonly path: string;
  /**
   * `POST` only for reads that cannot express their question in a URL — the report
   * runner is the one in this product. Anything that *changes* state is a mutation
   * and must not be described here; prefetching it would fire it during a render.
   */
  readonly method?: ApiQueryMethod;
  readonly body?: unknown;
  /**
   * How long a hydrated answer is trusted before the browser refetches it.
   *
   * Leaving this unset takes the provider default (15s), which means the client
   * refetches almost immediately after hydrating. That refetch is a *background*
   * one — `isLoading` stays false and no skeleton is drawn — so it is not a flash,
   * but it is a wasted round trip for anything that does not change by the second.
   */
  readonly staleTime?: number;
  /**
   * Applied to the raw payload on **both** sides, so the cache holds one shape.
   *
   * Without it a server prefetch would store the API's snake_case body and the
   * client's own fetch would store the parsed object, and whichever landed second
   * would silently change the type the page rendered.
   *
   * The result must be JSON-serializable: dehydration is `JSON.stringify` in all but
   * name, and a `Date` or a `Map` in here arrives in the browser as something else.
   */
  readonly parse?: (payload: unknown) => T;
}

/**
 * Declares a query.
 *
 * Only an identity function, but it pins `T` at the declaration site so the hook and
 * the prefetch both infer the response type from the same place — and so a spec is
 * type-checked where it is written rather than where it is used.
 */
export function apiQuery<T>(spec: ApiQuerySpec<T>): ApiQuerySpec<T> {
  return spec;
}

/**
 * The `fetch` init a spec asks for, or undefined for a plain GET.
 *
 * Shared so the server prefetch and the browser send byte-identical requests. A GET
 * returns undefined rather than `{ method: "GET" }` so callers can spread it without
 * overriding headers they set themselves.
 */
export function specRequestInit(spec: ApiQuerySpec<unknown>): RequestInit | undefined {
  if (spec.method === undefined || spec.method === "GET") return undefined;

  return {
    method: spec.method,
    ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
  };
}

/** The value to cache: parsed if the spec says how, otherwise the payload as-is. */
export function specResult<T>(spec: ApiQuerySpec<T>, payload: unknown): T {
  return spec.parse ? spec.parse(payload) : (payload as T);
}
