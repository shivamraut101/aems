"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { SESSION_QUERY } from "@/lib/api";
import type { Session } from "@/lib/session";

import { RenderedAtProvider } from "./relative-time";

/**
 * The query client, and the one thing that is in it before anything renders.
 *
 * `initialSession` comes from `app/layout.tsx`, which resolved it on the server from
 * the request's own cookies. Writing it into the cache in the client's *constructor*
 * — not in an effect, not in a `HydrationBoundary` — is deliberate: it means the very
 * first render of the app shell, on the server and again during hydration, already
 * knows who is signed in and which role they hold. Anything later than that is a
 * second paint, and a second paint of the navigation is exactly the flash this was
 * built to remove.
 *
 * A null session is NOT seeded, and that distinction matters. `null` is a legitimate
 * cached answer meaning "signed in but no profile", and with `SESSION_QUERY`'s five
 * minute `staleTime` it would be served to the sign-in form's own `fetchQuery` —
 * so a user who had just authenticated would be told, from cache, that they are
 * nobody. Absent means "not answered yet"; that is the right state for /login.
 */
export function Providers({
  initialSession,
  renderedAt,
  children,
}: {
  initialSession: Session | null;
  /**
   * The request's own instant, measured once in `app/layout.tsx`. Every relative
   * timestamp on the page is computed from it until the browser has mounted, which is
   * what keeps the server's HTML and the client's first render character-identical.
   */
  renderedAt: number;
  children: React.ReactNode;
}) {
  // Created in state so each browser session gets one client — a module-level
  // client would be shared across users during SSR.
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: {
        queries: {
          // Monitoring data ages fast; a stale dashboard is a misleading one.
          staleTime: 15_000,
          refetchOnWindowFocus: true,
          retry: 1,
        },
      },
    });

    if (initialSession) created.setQueryData(SESSION_QUERY.queryKey, initialSession);

    return created;
  });

  return (
    <QueryClientProvider client={client}>
      <RenderedAtProvider value={renderedAt}>{children}</RenderedAtProvider>
    </QueryClientProvider>
  );
}
