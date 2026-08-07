/**
 * Session shape, route access policy and navigation.
 *
 * Deliberately framework-free and dependency-light: `middleware.ts` runs this on the
 * edge, server components run it in Node, and the shell runs it in the browser. Keep
 * `next/*`, React and the Supabase clients out of this file — importing any of them
 * here would drag them into the middleware bundle.
 *
 * None of this is a security boundary. RLS is. This decides what to *render*, so the
 * UI stops offering actions the database will refuse.
 */

import { z } from "zod";

export type UserRole = "super_admin" | "manager" | "employee";

const ROLES = ["super_admin", "manager", "employee"] as const;

export interface Session {
  profileId: string;
  companyId: string;
  /** Null until `GET /api/auth/me` joins `companies(name)` — see the shell's fallback. */
  companyName: string | null;
  email: string;
  fullName: string;
  role: UserRole;
  department: string | null;
  monitoringEnabled: boolean;
}

/**
 * `GET /api/auth/me`, as the API actually returns it today (`routes/auth.ts:14`).
 *
 * `companies` is optional and accepted in both shapes PostgREST emits for a join,
 * so the shell picks up a real company name the moment the API selects one without
 * needing a matching dashboard release.
 */
const companyJoin = z.object({ name: z.string() });

const meResponseSchema = z.object({
  profile: z
    .object({
      id: z.string().min(1),
      company_id: z.string().min(1),
      email: z.string().min(1),
      full_name: z.string().nullish(),
      role: z.enum(ROLES),
      department: z.string().nullish(),
      monitoring_enabled: z.boolean().nullish(),
      companies: z.union([companyJoin, z.array(companyJoin)]).nullish(),
    })
    .nullable(),
});

/**
 * Maps the API's snake_case profile onto the session the UI works in.
 *
 * Returns null rather than throwing for every failure mode — no profile, a shape we
 * do not recognise, a role outside the three the RLS policies know about. A caller
 * that gets null has exactly one correct response (treat the person as signed out),
 * and that is easier to get right than a try/catch at six call sites.
 */
export function parseMeResponse(payload: unknown): Session | null {
  const parsed = meResponseSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.profile) return null;

  const profile = parsed.data.profile;
  const company = Array.isArray(profile.companies) ? profile.companies[0] : profile.companies;

  return {
    profileId: profile.id,
    companyId: profile.company_id,
    companyName: company?.name ?? null,
    email: profile.email,
    // A profile with no name still has to render as a person, not as a blank.
    fullName: profile.full_name?.trim() || emailLocalPart(profile.email),
    role: profile.role,
    department: profile.department ?? null,
    monitoringEnabled: profile.monitoring_enabled ?? true,
  };
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export function roleLabel(role: UserRole): string {
  switch (role) {
    case "super_admin":
      return "Super Admin";
    case "manager":
      return "Manager";
    case "employee":
      return "Employee";
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Icon identity, not the component — `session.ts` must not import lucide. */
export type NavIcon =
  | "overview"
  | "people"
  | "activity"
  | "devices"
  | "reports"
  | "insights"
  | "settings"
  | "me"
  | "myDevices"
  | "account";

/**
 * Which half of the sidebar an entry belongs to.
 *
 * `workspace` is the company — other people's work, read on their behalf.
 * `personal` is the reader's own record: their activity, the machines enrolled to
 * them and what each one collects, and their account. The split is not decoration.
 * Non-negotiable #3 says an employee can read their own data, and a manager who has
 * to hunt for their own row among the company's is being told, by the layout, that
 * the personal view is an afterthought.
 */
export type NavGroup = "workspace" | "personal";

/** Render order. A group with no entries for the current role is simply skipped. */
export const NAV_GROUPS: readonly NavGroup[] = ["workspace", "personal"];

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  group: NavGroup;
  /** Roles that may reach this destination. Mirrors the API's preHandlers. */
  roles: readonly UserRole[];
}

const MANAGERS: readonly UserRole[] = ["manager", "super_admin"];
const ADMINS: readonly UserRole[] = ["super_admin"];
const EVERYONE: readonly UserRole[] = ROLES;

/**
 * The sidebar, per docs/design.md — flat, no nesting, no collapsible tree.
 *
 * This table is the whole authorization surface of the UI, which is why it is data
 * with a test file pointed at it rather than a set of conditionals spread over ten
 * components. `roles` sits on the entry so a new destination cannot be added without
 * someone deciding who sees it, and `canAccessPath` reads the same rows, so the
 * sidebar and the permission wall can never disagree about who may go where.
 *
 * The agreed matrix:
 *
 * | Role        | Sees                                                              |
 * | ----------- | ----------------------------------------------------------------- |
 * | Employee    | My activity, My devices, Account — their own record, nothing else  |
 * | Manager     | + Overview, People, Activity, Devices, Reports, AI Insights        |
 * | Super Admin | + Settings (policy, restrictions, categories, monitoring toggles)   |
 *
 * A manager reads the whole company and runs reports but cannot change policy or
 * people; that is why Settings is `ADMINS` and everything else operational is
 * `MANAGERS`. None of this is the boundary — the API's guards and RLS are. This
 * stops the app offering a door the server will not open.
 */
export const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: "overview", group: "workspace", roles: MANAGERS },
  { href: "/people", label: "People", icon: "people", group: "workspace", roles: MANAGERS },
  { href: "/activity", label: "Activity", icon: "activity", group: "workspace", roles: MANAGERS },
  { href: "/devices", label: "Devices", icon: "devices", group: "workspace", roles: MANAGERS },
  { href: "/reports", label: "Reports", icon: "reports", group: "workspace", roles: MANAGERS },
  { href: "/insights", label: "AI Insights", icon: "insights", group: "workspace", roles: MANAGERS },
  { href: "/settings", label: "Settings", icon: "settings", group: "workspace", roles: ADMINS },

  // The personal group. Every role carries all three, so nobody signs in to an empty
  // sidebar and no role has to be told where its own data lives.
  { href: "/me", label: "My activity", icon: "me", group: "personal", roles: EVERYONE },
  // Non-negotiables #1 and #4: a person must be able to see which devices are theirs,
  // what each one collects and under which policy version — and withdraw that consent.
  // A consent that can only be given is not consent, and the revoke endpoint has
  // existed with nothing in the product calling it.
  //
  // The href must match the page's directory — `app/(app)/my-devices/`. It briefly did
  // not: this row read `/me/devices` while the page was built one level up, so the one
  // sidebar link carrying a compliance obligation was a 404 while every other link to
  // that same screen worked. `session.test.ts` now derives the served routes from the
  // filesystem and asserts every entry lands on one, which catches the disagreement
  // whichever side of it moves.
  { href: "/my-devices", label: "My devices", icon: "myDevices", group: "personal", roles: EVERYONE },
  { href: "/account", label: "Account", icon: "account", group: "personal", roles: EVERYONE },
];

export function navigationForRole(role: UserRole): NavItem[] {
  return NAV.filter((item) => item.roles.includes(role));
}

/**
 * The same list, split into the groups the sidebar draws a rule between.
 *
 * Empty groups are dropped rather than returned empty, so a caller can render one
 * separator per group boundary without having to know that an employee has no
 * workspace entries at all.
 */
export function navigationGroupsForRole(
  role: UserRole,
): { group: NavGroup; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({
    group,
    items: NAV.filter((item) => item.group === group && item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}

/**
 * Does `pathname` sit under `href`?
 *
 * Segment-aware rather than a bare `startsWith`, which lit "My activity" on any
 * route beginning "/me" — "/members", "/metrics" — and would light Overview on
 * every page in the app.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one entry that owns this path, or null if the sidebar does not claim it.
 *
 * "Most specific wins" is what makes nesting safe. No two `NAV` entries nest right
 * now, but routes beneath them exist — `/settings/restrictions` is a page with no row
 * of its own — and the moment a child gets its own entry, `isNavActive` answers true
 * for both it and its parent. Highlighting on that alone lights two rows at once, and
 * judging *access* on the first match would let the looser parent decide who may enter
 * the child, so a narrow section nested under a broad one would silently inherit the
 * broad audience.
 *
 * Both questions resolve through this one function, so highlighting and access can
 * never pick different owners for the same path.
 */
export function navClaimFor(pathname: string): NavItem | null {
  const claimed = NAV.filter((item) => isNavActive(item.href, pathname));
  if (claimed.length === 0) return null;

  return claimed.reduce((a, b) => (b.href.length > a.href.length ? b : a));
}

/** The href the sidebar should mark as the current section — at most one. */
export function activeNavHref(pathname: string): string | null {
  return navClaimFor(pathname)?.href ?? null;
}

/**
 * May this role render this path?
 *
 * Anything the sidebar does not claim is allowed — this gate exists to stop a role
 * landing on a screen built from endpoints it cannot call, not to be an allowlist.
 * The most specific claim wins, so "/people/abc" is judged by "/people".
 */
export function canAccessPath(role: UserRole, pathname: string): boolean {
  const claim = navClaimFor(pathname);
  if (!claim) return true;

  return claim.roles.includes(role);
}

/** Where this role belongs when they have not asked for anywhere in particular. */
export function landingPathForRole(role: UserRole): string {
  return role === "employee" ? "/me" : "/";
}

/**
 * The request header middleware uses to tell a server component which path is being
 * rendered.
 *
 * Layouts do not receive the pathname — Next deliberately withholds it so a layout
 * can be reused across the routes beneath it — and `usePathname()` is a client hook,
 * which is a render too late for a decision that must be made before the first paint.
 * Middleware already runs on every request and already knows, so it says.
 *
 * Not a security input. It is set by our own middleware on the way in, and a value a
 * client tried to spoof would only change which of *their own* pages they are sent
 * to; every read behind it is still checked by the API and by RLS.
 */
export const PATHNAME_HEADER = "x-aems-pathname";

/**
 * Where this person should be sent instead of `pathname`, or null to render it.
 *
 * The case this exists for, in the client's words: *"I have just enrolled with my
 * employee id but I am not seeing anything near to it."* An employee signing in
 * landed on `/` — the manager Overview — and met a permission wall as the first
 * screen of the product. `/` is not a page they were refused; it is a page that was
 * never theirs, and the honest response is to open the one that is.
 *
 * Only the landing path is redirected. A role that reaches some *other* section it
 * cannot read keeps the explanatory wall, because there the reader followed a link
 * and deserves to be told why it went nowhere rather than being silently moved.
 */
export function landingRedirectFor(role: UserRole, pathname: string): string | null {
  if (pathname !== "/") return null;

  const landing = landingPathForRole(role);
  return landing === "/" ? null : landing;
}

// ---------------------------------------------------------------------------
// Route access
// ---------------------------------------------------------------------------

/**
 * Character-code scan rather than a regex literal, so no control character has to be
 * written into this source file to detect one.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Routes reachable without a session. Everything else goes through middleware. */
/**
 * Where somebody carrying a temporary password is sent, and the one route the
 * must-change gate lets through — otherwise it would redirect the page it redirects to.
 */
export const SET_PASSWORD_PATH = "/set-password";

/** Reachable with no session at all. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/forgot-password" ||
    // Supabase lands the recovery link here with a session in the URL fragment, which
    // the middleware cannot see — so it has to be public or the link bounces to /login.
    pathname === "/reset-password"
  );
}

/**
 * Sanitises a `?next=` value before anyone navigates to it.
 *
 * An unchecked redirect target is a phishing primitive: a link to our own login page
 * that lands on someone else's site after a successful sign-in is more convincing
 * than any lookalike domain. Only a same-origin path survives — and never the login
 * page itself, which would loop.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";

  // Control characters (newline, tab, NUL) are how a target smuggles past a naive
  // prefix check and is then re-parsed by the browser as something else.
  if (hasControlCharacter(raw)) return "/";

  if (!raw.startsWith("/")) return "/";
  // "//host" is protocol-relative and "/\host" is normalised to it by browsers.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";

  const pathname = raw.split(/[?#]/)[0] ?? "/";
  if (isPublicPath(pathname)) return "/";

  return raw;
}

/** Where an unauthenticated request to `pathname` should be sent. */
export function loginRedirectPath(pathname: string, search: string): string {
  const target = safeNextPath(`${pathname}${search}`);
  if (target === "/") return "/login";
  return `/login?next=${encodeURIComponent(target)}`;
}

// ---------------------------------------------------------------------------
// API location
// ---------------------------------------------------------------------------

export function apiBaseUrl(): string {
  return process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
