"use client";

import { cn } from "@aems/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CircleUser,
  FileText,
  LayoutDashboard,
  Laptop,
  Lock,
  LogOut,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { useSession } from "@/lib/api";
import {
  canAccessPath,
  isNavActive,
  isPublicPath,
  landingPathForRole,
  navigationForRole,
  roleLabel,
  type NavIcon,
  type Session,
} from "@/lib/session";
import { createClient } from "@/lib/supabase";

/** Icon identity lives in `session.ts` (which middleware imports); the components live here. */
const ICONS: Record<NavIcon, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  people: Users,
  activity: Activity,
  devices: Laptop,
  reports: FileText,
  insights: Sparkles,
  settings: Settings,
  me: CircleUser,
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, isLoading } = useSession();

  // /login draws its own page. Rendering it inside the sidebar would show the
  // signed-out user a menu of places they cannot go.
  if (isPublicPath(pathname)) return <>{children}</>;

  const nav = session ? navigationForRole(session.role) : [];
  const permitted = session ? canAccessPath(session.role, pathname) : true;

  return (
    <div className="flex min-h-screen">
      <nav
        aria-label="Main"
        className="hidden w-60 shrink-0 flex-col border-r bg-card px-3 py-5 md:flex"
      >
        <Link
          href={session ? landingPathForRole(session.role) : "/"}
          className="mb-7 flex items-center gap-2.5 rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-[13px] font-semibold tracking-tight text-primary-foreground">
            A
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-tight tracking-tight">AEMS</span>
            {/* The positioning line, where a product states what it is. docs/design.md
                forbids surveillance framing in UI copy, so the one permanent piece of
                self-description had better be the intended one. */}
            {/* `whitespace-nowrap` without `truncate`: this line is either shown in
                full or it is a defect. An ellipsis here reads as a broken layout, and
                the sidebar is sized (w-60) so the full phrase fits. */}
            <span className="block whitespace-nowrap text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
              Workforce intelligence
            </span>
          </span>
        </Link>

        <ul className="flex flex-col gap-0.5">
          {isLoading
            ? [0, 1, 2, 3].map((i) => (
                <li key={i} className="px-2.5 py-1.5">
                  <span className="block h-4 w-28 rounded bg-secondary" />
                </li>
              ))
            : nav.map((item) => {
                const active = isNavActive(item.href, pathname);
                const Icon = ICONS[item.icon];

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-md py-1.5 pl-3.5 pr-2.5 text-sm transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        // A navy rule marks the current section, not indigo: indigo is
                        // reserved product-wide for model output, and spending it on
                        // navigation would make "this came from AI" ambiguous everywhere.
                        active
                          ? "bg-secondary font-medium text-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-primary"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                    >
                      <Icon
                        className={cn("h-4 w-4 shrink-0", active ? "text-foreground" : "text-muted-foreground/80")}
                        aria-hidden
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
        </ul>

        <div className="mt-auto pt-6">
          <SessionCard session={session ?? null} loading={isLoading} />
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        {permitted ? children : <NoAccess session={session ?? null} pathname={pathname} />}
      </main>
    </div>
  );
}

/**
 * Who is signed in, and the way out.
 *
 * `companyName` is null until `GET /api/auth/me` selects the joined company row —
 * the department is shown in its place rather than a bare UUID, which would be a
 * worse answer than none.
 */
function SessionCard({ session, loading }: { session: Session | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-1.5 border-t px-2 pt-4">
        <span className="block h-3.5 w-24 rounded bg-secondary" />
        <span className="block h-3 w-16 rounded bg-secondary" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="border-t px-2 pt-4">
        <p className="text-xs text-muted-foreground">Not signed in</p>
        <Link
          href="/login"
          className="mt-1 inline-block rounded text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const context = session.companyName ?? session.department;

  return (
    <div className="border-t px-2 pt-4">
      <p className="truncate text-sm font-medium leading-tight" title={session.email}>
        {session.fullName}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {roleLabel(session.role)}
        {context ? ` · ${context}` : ""}
      </p>
      <SignOutButton />
    </div>
  );
}

function SignOutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await createClient().auth.signOut();
    } catch {
      // Already gone as far as this browser is concerned; carry on to /login so a
      // failed network call cannot strand someone inside the app.
    }
    // Drop every cached answer before the next person uses this browser.
    queryClient.clear();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="mt-2.5 flex items-center gap-1.5 rounded-md px-0.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden />
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}

/**
 * Shown when a role reaches a section its endpoints would refuse.
 *
 * The database is the boundary; this only stops the app rendering a screen built
 * from calls that will come back 403, which used to look like a broken page.
 */
function NoAccess({ session, pathname }: { session: Session | null; pathname: string }) {
  const home = session ? landingPathForRole(session.role) : "/";
  // Never offer a link back to the page the reader is already looking at.
  const showHomeLink = home !== pathname;

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="max-w-md rounded-lg border bg-card p-6">
        <Lock className="h-5 w-5 text-muted-foreground" aria-hidden />
        <h1 className="mt-3 text-base font-semibold tracking-tight">You do not have access to this</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This section is limited to other roles in your company. If you believe that is
          wrong, ask your administrator.
        </p>
        {showHomeLink ? (
          <Link
            href={home}
            className="mt-4 inline-block rounded text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to your dashboard
          </Link>
        ) : null}
      </div>
    </div>
  );
}
