"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  cn,
} from "@aems/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CircleUser,
  FileText,
  LayoutDashboard,
  Laptop,
  Lock,
  LogOut,
  Menu,
  MonitorSmartphone,
  Settings,
  Sparkles,
  UserCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { RouteSkeleton } from "@/components/states/page-loading";
import { useSession } from "@/lib/api";
import {
  activeNavHref,
  canAccessPath,
  isPublicPath,
  landingPathForRole,
  navigationGroupsForRole,
  roleLabel,
  type NavGroup,
  type NavIcon,
  type NavItem,
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
  myDevices: MonitorSmartphone,
  account: UserCog,
};

/** The viewport at which the sidebar exists. Must match the `md:` classes below. */
const SIDEBAR_MEDIA_QUERY = "(min-width: 768px)";

type NavSection = { group: NavGroup; items: NavItem[] };

/**
 * Steps aside for /login, which draws its own page.
 *
 * The split is not cosmetic. `useSession()` lives in the inner component, so it is
 * never *mounted* on the sign-in screen — a hook called before an early return would
 * still fire `GET /api/auth/me` for a person who by definition has no session, spend
 * a round trip to be told 401, and leave the query sitting in an error state that the
 * form then has to fetch its way out of a second later.
 */
export function AppShell({
  initialSession,
  children,
}: {
  initialSession: Session | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (isPublicPath(pathname)) return <>{children}</>;

  return (
    <SignedInShell initialSession={initialSession} pathname={pathname}>
      {children}
    </SignedInShell>
  );
}

/**
 * The navigation and the frame around every signed-in page.
 *
 * `initialSession` is the profile `app/layout.tsx` resolved on the server. It is not
 * a fallback for a slow query — it is the answer, present before the first render,
 * and the query merely keeps it current. That is why there is no loading branch in
 * the navigation any more: the shell used to draw four grey bars and then replace
 * them with the real destinations, which for an employee meant four rows collapsing
 * to one in front of the reader.
 *
 * The query is still read because identity can change *within* a session — the
 * sign-in form writes it, sign-out clears it — and `undefined` there means "the cache
 * has no opinion", which is different from a cached `null` meaning "no profile".
 *
 * **Two renderings of one navigation.** The sidebar is `md:flex` and below that it is
 * gone; until now nothing replaced it, so on a phone the product had no navigation at
 * all — no home link, no way to change section short of editing the URL, and no way to
 * sign out, because the session card lives inside that same hidden `<nav>`. The mobile
 * header and its drawer render the same `NavSections` from the same role-filtered list,
 * so the two can never offer different destinations.
 */
function SignedInShell({
  initialSession,
  pathname,
  children,
}: {
  initialSession: Session | null;
  pathname: string;
  children: React.ReactNode;
}) {
  const { data } = useSession();
  const session = data === undefined ? initialSession : data;

  /**
   * The route the reader has asked for but has not arrived at yet.
   *
   * Next's own `loading.tsx` covers the destination once the router commits, and in a
   * production build that is quick. It is not the whole story though: the router only
   * commits once it has the segment, and until then the previous page stays on screen
   * — so a click can look like it did nothing, which is the complaint this answers.
   * In `next dev` it is worse, because the first visit to a route compiles it on
   * demand (up to nine seconds here) and `loading.tsx` is *inside* the bundle being
   * compiled, so Next has no fallback to show even in principle.
   *
   * Holding the target here closes both. It is set from the click, in already-loaded
   * client code, so the skeleton and the highlight move on the same frame regardless
   * of what the server is doing.
   */
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  // Arrival clears it. Keyed on the pathname rather than a navigation callback so Back,
  // Forward and any programmatic redirect clear it too — none of those run the click
  // handler, and a stale value would leave a skeleton over a page that had landed.
  useEffect(() => setPendingPath(null), [pathname]);

  const navigating = pendingPath !== null && pendingPath !== pathname;

  const groups = session ? navigationGroupsForRole(session.role) : [];
  // At most one entry is marked, resolved by the most specific claim — a nested route
  // like "/settings/restrictions" lights "Settings" and nothing else.
  // The pending route wins while one is in flight, so the highlight moves on the click
  // rather than on arrival. Marking the old item until the new page loads is what makes
  // a slow navigation read as a click that missed.
  const active = activeNavHref(navigating ? pendingPath : pathname);
  const permitted = session ? canAccessPath(session.role, pathname) : true;
  const home = session ? landingPathForRole(session.role) : "/";

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <MobileNav
        home={home}
        groups={groups}
        active={active}
        pathname={pathname}
        session={session}
        onSelect={setPendingPath}
      />

      {/*
        Pinned to the viewport, not to the page.

        As an ordinary flex child of a `min-h-screen` row this stretched to the height
        of whatever the page happened to contain, so the window scrolled it off the top
        along with the content — on a long table you scrolled down and the navigation
        was simply gone. `overflow-y-auto` was inert for the same reason: an element
        sized to its own content never overflows, so nothing could scroll inside it.
        And `mt-auto` on the account card settled it at the bottom of the *document*
        rather than the screen, which is what left a tall empty rail under a three-item
        employee nav.

        `fixed` rather than `sticky`, which was tried first and measured: sticky pins an
        element only while its containing block is still under the viewport, and this
        document is ~20px taller than the shell that contains the rail, so the last 20px
        of every scroll dragged it upward again. That gap is real but not worth building
        on — a rail that stays put for all but the final 20px is still a rail that moves.
        Fixed positioning answers to the viewport alone, so no measurement of the shell,
        the document or anything between them can reintroduce the bug.

        The cost is that the rail leaves the flex flow and can no longer reserve its own
        width, which is why `<main>` carries `md:ml-60` below. The two must agree: change
        `w-60` here and change the margin there. That coupling is the price of the
        guarantee, and it is cheaper than the alternative — an `h-screen overflow-hidden`
        shell with the scroll moved inside `<main>` would pin the rail just as reliably
        but take browser scroll restoration and `#anchor` links with it.
      */}
      <nav
        aria-label="Main"
        className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r bg-card px-3 py-5 md:fixed md:inset-y-0 md:left-0 md:flex"
      >
        <Brand home={home} className="mb-7" />
        <NavSections groups={groups} active={active} onSelect={setPendingPath} />
        <div className="mt-auto pt-6">
          <SessionCard session={session} />
        </div>
      </nav>

      {/*
        `md:ml-60` replaces the width the fixed rail above no longer reserves. Without it
        the content sits underneath the navigation rather than beside it. Below `md` the
        rail is hidden entirely and the margin goes with it.
      */}
      <main className="min-w-0 flex-1 md:ml-60">
        {/*
          The destination's skeleton, shown from the click rather than from the commit.
          `children` is still the previous page at this point — rendering it would be
          the "nothing happened" the reader complained about, so it is replaced rather
          than layered over. Next's own `loading.tsx` takes over seamlessly once the
          router commits, because both draw the same shape from `RouteSkeleton`.
        */}
        {navigating ? (
          <RouteSkeleton path={pendingPath} />
        ) : permitted ? (
          children
        ) : (
          <NoAccess session={session ?? null} pathname={pathname} />
        )}
      </main>
    </div>
  );
}

/**
 * The product's name, and the link home.
 *
 * "Home" is `landingPathForRole`, not "/" — sending an employee to the manager
 * Overview from the one link that is on every screen is the reported defect wearing
 * a different hat.
 */
function Brand({ home, className }: { home: string; className?: string }) {
  return (
    <Link
      href={home}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
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
            both places it appears are sized so the full phrase fits. */}
        <span className="block whitespace-nowrap text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
          Workforce intelligence
        </span>
      </span>
    </Link>
  );
}

/**
 * The destinations, grouped, with a rule between the company and the reader's own record.
 *
 * No skeleton anywhere in here on purpose. The role is known before this renders, so a
 * placeholder would only ever be shown in the one case where guessing is impossible —
 * no session at all — and guessing wrong is what the swap was.
 */
function NavSections({
  groups,
  active,
  onNavigate,
  onSelect,
}: {
  groups: NavSection[];
  active: string | null;
  /** Closes the drawer. Absent in the sidebar, which is not covering anything. */
  onNavigate?: () => void;
  /** Reports the target so the shell can paint its skeleton on the click. */
  onSelect?: (href: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {groups.map((section, index) => (
        <ul
          key={section.group}
          className={cn("flex flex-col gap-0.5", index > 0 && "mt-3 border-t pt-3")}
        >
          {section.items.map((item) => {
            const current = active === item.href;
            const Icon = ICONS[item.icon];

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    onSelect?.(item.href);
                    onNavigate?.();
                  }}
                  className={cn(
                    // `py-2` below md is a 36px touch target; the sidebar, which only
                    // exists at md and up, is driven by a pointer and can be denser.
                    "relative flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-sm transition-colors md:py-1.5",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    // A navy rule marks the current section, not indigo: indigo is
                    // reserved product-wide for model output, and spending it on
                    // navigation would make "this came from AI" ambiguous everywhere.
                    current
                      ? "bg-secondary font-medium text-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-primary"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      current ? "text-foreground" : "text-muted-foreground/80",
                    )}
                    aria-hidden
                  />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}

/**
 * The phone and small-tablet navigation: a header bar, and the sidebar in a drawer.
 *
 * Everything modal is Radix's, through the `Sheet` primitive — focus trap, Escape,
 * scroll lock, focus returning to the menu button. Two things are ours, and both are
 * bugs if omitted:
 *
 *  - **A route change closes it.** The link's `onClick` covers a tap; the effect on
 *    `pathname` covers Back, Forward and any programmatic navigation, which never run
 *    that handler and would otherwise leave the drawer sitting over the new page.
 *  - **Crossing to a desktop width closes it.** `SheetContent` is portalled to the
 *    body, so hiding it with `md:hidden` would leave an invisible dialog holding the
 *    focus trap and the scroll lock over a page that looks perfectly normal. Closing
 *    it is the only correct response to the sidebar reappearing.
 */
function MobileNav({
  home,
  groups,
  active,
  pathname,
  session,
  onSelect,
}: {
  home: string;
  groups: NavSection[];
  active: string | null;
  pathname: string;
  session: Session | null;
  onSelect?: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const query = window.matchMedia(SIDEBAR_MEDIA_QUERY);
    const close = () => {
      if (query.matches) setOpen(false);
    };

    close();
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 md:hidden">
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="h-4 w-4" aria-hidden />
          </button>
        </SheetTrigger>
        <Brand home={home} />
      </header>

      <SheetContent side="left" onOpenAutoFocus={focusFirstDestination}>
        <SheetHeader>
          {/* Radix labels the dialog from these; the drawer's visible identity is the
              wordmark, so the accessible name is carried separately rather than left
              to a heading that is really a logo. */}
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Move between sections, and sign out.
          </SheetDescription>
          <Brand home={home} className="-ml-2" />
        </SheetHeader>

        <nav aria-label="Main" className="min-w-0">
          <NavSections
            groups={groups}
            active={active}
            onSelect={onSelect}
            onNavigate={() => setOpen(false)}
          />
        </nav>

        <div className="mt-auto">
          <SessionCard session={session} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Puts the opening focus on the first destination, not on Sign out.
 *
 * Radix focuses `focusFirst(removeLinks(getTabbableCandidates(container)))` when a
 * dialog mounts — it **deliberately skips anchors**, on the reasoning that a link is
 * rarely a dialog's primary action. In a navigation drawer whose entire body is links
 * that reasoning inverts: the first non-link tabbable is the Sign out button, so
 * opening the menu on a phone and pressing Enter signs the person out. Measured, not
 * theorised — `document.activeElement` came back as the Sign out button.
 *
 * Falls through to Radix's default when there is no navigation to focus (no session),
 * because preventing the default without providing a target leaves focus on the body
 * and the trap with nothing inside it.
 */
function focusFirstDestination(event: Event) {
  const content = event.currentTarget as HTMLElement | null;
  const first = content?.querySelector<HTMLElement>("nav a[href]");
  if (!first) return;

  event.preventDefault();
  first.focus();
}

/**
 * Who is signed in, and the way out.
 *
 * `companyName` is null until `GET /api/auth/me` selects the joined company row —
 * the department is shown in its place rather than a bare UUID, which would be a
 * worse answer than none.
 */
function SessionCard({ session }: { session: Session | null }) {
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

/**
 * Sign out, and stay visibly busy until /login is actually on screen.
 *
 * The navigation is wrapped in a transition and `isPending` is folded into `busy`,
 * so the label does not settle back to "Sign out" while the browser is still
 * fetching the next route. A control that reports itself finished before anything
 * has moved is the same defect the sign-in button had.
 */
function SignOutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = leaving || pending;

  async function signOut() {
    setLeaving(true);
    try {
      await createClient().auth.signOut();
    } catch {
      // Already gone as far as this browser is concerned; carry on to /login so a
      // failed network call cannot strand someone inside the app.
    }
    // Drop every cached answer before the next person uses this browser.
    queryClient.clear();

    // No router.refresh() here, and that is the whole subtlety. Refreshing re-renders
    // the route being left — which the user has, one line above, just lost access to.
    // Middleware answers that RSC request with a redirect to /login, and the pending
    // transition sits on it: measured, the sign-out never completed. The route we are
    // going to is a different segment and is fetched fresh regardless, and /login's
    // shell renders no session at all, so there is nothing stale left to correct.
    startTransition(() => {
      router.replace("/login");
    });
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="mt-2.5 flex items-center gap-1.5 rounded-md px-0.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:py-1"
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
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
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
