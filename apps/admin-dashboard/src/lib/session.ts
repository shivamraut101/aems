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
  | "me";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Roles that may reach this destination. Mirrors the API's preHandlers. */
  roles: readonly UserRole[];
}

const MANAGERS: readonly UserRole[] = ["manager", "super_admin"];
const ADMINS: readonly UserRole[] = ["super_admin"];
const EVERYONE: readonly UserRole[] = ROLES;

/**
 * The sidebar, per docs/design.md — flat, no nesting, no collapsible tree.
 *
 * `roles` is on the entry rather than in a separate table so a new destination
 * cannot be added without someone deciding who sees it. Every manager destination
 * here is backed by a `requireManager` route; Settings is company configuration,
 * which only a super admin can write.
 */
export const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: "overview", roles: MANAGERS },
  { href: "/people", label: "People", icon: "people", roles: MANAGERS },
  { href: "/activity", label: "Activity", icon: "activity", roles: MANAGERS },
  { href: "/devices", label: "Devices", icon: "devices", roles: MANAGERS },
  { href: "/reports", label: "Reports", icon: "reports", roles: MANAGERS },
  { href: "/insights", label: "AI Insights", icon: "insights", roles: MANAGERS },
  { href: "/settings", label: "Settings", icon: "settings", roles: ADMINS },
  // Non-negotiable #3: employees can read their own data, so every role keeps a
  // destination and nobody signs in to an empty sidebar.
  { href: "/me", label: "My activity", icon: "me", roles: EVERYONE },
];

export function navigationForRole(role: UserRole): NavItem[] {
  return NAV.filter((item) => item.roles.includes(role));
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
 * May this role render this path?
 *
 * Anything the sidebar does not claim is allowed — this gate exists to stop a role
 * landing on a screen built from endpoints it cannot call, not to be an allowlist.
 * The most specific claim wins, so "/people/abc" is judged by "/people".
 */
export function canAccessPath(role: UserRole, pathname: string): boolean {
  const claimed = NAV.filter((item) => isNavActive(item.href, pathname));
  if (claimed.length === 0) return true;

  const mostSpecific = claimed.reduce((a, b) => (b.href.length > a.href.length ? b : a));
  return mostSpecific.roles.includes(role);
}

/** Where this role belongs when they have not asked for anywhere in particular. */
export function landingPathForRole(role: UserRole): string {
  return role === "employee" ? "/me" : "/";
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
export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/login/");
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
