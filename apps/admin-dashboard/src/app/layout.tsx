import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { THEME_INIT_SCRIPT } from "@/components/theme-toggle";
import {
  PATHNAME_HEADER,
  isPublicPath,
  landingRedirectFor,
  type Session,
} from "@/lib/session";
import { getServerSession } from "@/lib/supabase-server";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AEMS — Workforce Intelligence",
  description: "Activity, productivity and device insight for company-owned devices.",
};

/**
 * The root layout, and the reason the app no longer flashes.
 *
 * The signed-in person is resolved **here**, on the server, from the request's own
 * cookies — before a byte of HTML is written. Every other approach was tried and
 * every one of them paints twice: `useSession()` in the shell renders placeholder
 * bars and then swaps them for eight navigation rows (or, for an employee, one), and
 * an effect that fetches on mount does the same thing a frame later. There is no
 * client-side fix for "the page does not yet know who is looking at it". The only
 * fix is to know before rendering.
 *
 * `Providers` then writes that session into the query cache in its constructor, so
 * `useSession()` in the shell is a cache read on its first call rather than a
 * request. The sidebar's first paint is its final paint.
 *
 * Three details that look incidental and are not:
 *
 *  - **`Providers` is never conditional.** It holds the query cache. Rendering it
 *    inside a branch would remount it whenever the branch flipped — signing in moves
 *    from /login to the app — and a remounted provider means a new `QueryClient`,
 *    which means everything the sign-in form just fetched is thrown away and fetched
 *    again. That is the "few seconds" pause the client described.
 *  - **The session is not resolved for /login.** A signed-out request has no token
 *    and the call would answer null anyway; skipping it keeps the first screen of the
 *    product off the API's critical path.
 *  - **Route protection is still `middleware.ts`.** This decides what is *drawn*.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? "";
  const publicRoute = isPublicPath(pathname);

  const session: Session | null = publicRoute ? null : await getServerSession();

  if (session) {
    const elsewhere = landingRedirectFor(session.role, pathname);
    // An employee's first screen after enrolling was "You do not have access to
    // this", because "/" is the manager Overview and sign-in sent everyone there.
    // Redirecting on the server means they never see that screen at all — not for
    // a frame, and not for the round trip a client-side redirect would cost.
    if (elsewhere) redirect(elsewhere);
  }

  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/*
          Sets the theme class before the first paint. Without it the page paints
          light and then swaps, which is a white flash on every load for anyone who
          chose dark — the same class of defect the prefetching and the relative-time
          fix were built to remove.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {/*
          One clock reading per request, shared with every relative timestamp below.
          Measured here rather than inside each of them so the server's HTML and the
          browser's first render describe the same instant — see `relative-time.tsx`.
        */}
        <Providers initialSession={session} renderedAt={Date.now()}>
          <AppShell initialSession={session}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
