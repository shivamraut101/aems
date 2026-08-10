import { readdirSync } from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NAV,
  NAV_GROUPS,
  PATHNAME_HEADER,
  activeNavHref,
  canAccessPath,
  isNavActive,
  isPublicPath,
  landingPathForRole,
  landingRedirectFor,
  loginRedirectPath,
  navClaimFor,
  navigationForRole,
  navigationGroupsForRole,
  parseMeResponse,
  roleLabel,
  safeNextPath,
  type UserRole,
} from "./session";

const ALL_ROLES: readonly UserRole[] = ["super_admin", "manager", "employee"];

describe("parseMeResponse", () => {
  const profile = {
    id: "11111111-1111-4111-8111-111111111111",
    company_id: "22222222-2222-4222-8222-222222222222",
    email: "ada@example.com",
    full_name: "Ada Lovelace",
    role: "manager",
    department: "Engineering",
    monitoring_enabled: true,
  };

  it("maps the API's snake_case profile onto a camelCase session", () => {
    expect(parseMeResponse({ profile })).toEqual({
      profileId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      companyName: null,
      email: "ada@example.com",
      fullName: "Ada Lovelace",
      role: "manager",
      department: "Engineering",
      monitoringEnabled: true,
    });
  });

  it("falls back to the email local part when the profile has no name", () => {
    const session = parseMeResponse({ profile: { ...profile, full_name: null } });
    expect(session?.fullName).toBe("ada");
  });

  it("reads a joined company name when the API supplies one", () => {
    const session = parseMeResponse({ profile: { ...profile, companies: { name: "Acme Ltd" } } });
    expect(session?.companyName).toBe("Acme Ltd");
  });

  it("returns null for an authenticated user with no linked profile", () => {
    expect(parseMeResponse({ profile: null })).toBeNull();
  });

  it("returns null rather than throwing on a shape it does not recognise", () => {
    expect(parseMeResponse({ profile: { id: 7 } })).toBeNull();
    expect(parseMeResponse(undefined)).toBeNull();
    expect(parseMeResponse("nope")).toBeNull();
  });

  it("rejects a role outside the three the RLS policies know about", () => {
    expect(parseMeResponse({ profile: { ...profile, role: "owner" } })).toBeNull();
  });
});

/**
 * The agreed role matrix, written out as the table it is.
 *
 * Asserted against exact arrays rather than `toContain`, because the failure this
 * guards against is an *extra* destination appearing for a role, and a containment
 * check cannot see one. If a row here has to change, that is a product decision
 * someone made — the test is the place it gets recorded.
 */
const EXPECTED_NAV: Record<UserRole, string[]> = {
  employee: ["/me", "/my-devices", "/account"],
  manager: [
    "/",
    "/people",
    "/activity",
    "/devices",
    "/reports",
    "/insights",
    "/me",
    "/my-devices",
    "/account",
  ],
  super_admin: [
    "/",
    "/people",
    "/activity",
    "/devices",
    "/reports",
    "/insights",
    "/settings",
    "/me",
    "/my-devices",
    "/account",
  ],
};

/**
 * Every route the App Router actually serves, read off disk.
 *
 * Derived rather than listed on purpose. A hand-copied array is the same class of
 * artefact as the bug it is meant to catch — one more place that can disagree with
 * reality — and it would have to be edited by the very commit that breaks it.
 *
 * The rules are Next's: a directory containing `page.tsx` is a route, and a segment
 * wrapped in parentheses is a route *group* that organises files without appearing in
 * the URL. `app/(app)/my-devices/page.tsx` is therefore `/my-devices`, not
 * `/(app)/my-devices`, which is exactly the distinction that makes eyeballing the tree
 * unreliable.
 *
 * Dynamic segments (`[profileId]`) are returned verbatim. No `NAV` entry is dynamic —
 * the sidebar links to sections, not to individual people — so they simply never match.
 */
function routedPaths(): Set<string> {
  const appDir = path.resolve(dirname(fileURLToPath(import.meta.url)), "..", "app");
  const found = new Set<string>();

  function walk(directory: string, segments: string[]): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // A parenthesised segment is a route group and contributes nothing to the URL.
        const grouping = entry.name.startsWith("(") && entry.name.endsWith(")");
        walk(path.join(directory, entry.name), grouping ? segments : [...segments, entry.name]);
      } else if (entry.name === "page.tsx" || entry.name === "page.ts") {
        found.add(`/${segments.join("/")}` === "/" ? "/" : `/${segments.join("/")}`);
      }
    }
  }

  walk(appDir, []);
  return found;
}

describe("navigationForRole", () => {
  it("gives a super admin every destination, Settings included", () => {
    const hrefs = navigationForRole("super_admin").map((item) => item.href);
    expect(hrefs).toEqual(NAV.map((item) => item.href));
    expect(hrefs).toEqual(EXPECTED_NAV.super_admin);
  });

  it("withholds Settings from a manager but keeps the team destinations", () => {
    expect(navigationForRole("manager").map((item) => item.href)).toEqual(EXPECTED_NAV.manager);
  });

  it("leaves an employee their own record and nothing of anyone else's", () => {
    const hrefs = navigationForRole("employee").map((item) => item.href);

    expect(hrefs).toEqual(EXPECTED_NAV.employee);
    // Named individually so a regression says which door opened.
    expect(hrefs).not.toContain("/");
    expect(hrefs).not.toContain("/people");
    expect(hrefs).not.toContain("/activity");
    expect(hrefs).not.toContain("/devices");
    expect(hrefs).not.toContain("/reports");
    expect(hrefs).not.toContain("/insights");
    expect(hrefs).not.toContain("/settings");
  });

  it("gives every role the personal destinations, compliance included", () => {
    // Non-negotiables #1/#3/#4: own data, the policy being monitored under, and the
    // ability to withdraw consent. A manager is monitored too.
    for (const role of ALL_ROLES) {
      const hrefs = navigationForRole(role).map((item) => item.href);
      expect(hrefs).toContain("/me");
      expect(hrefs).toContain("/my-devices");
      expect(hrefs).toContain("/account");
    }
  });

  it("never returns an empty sidebar for any role", () => {
    for (const role of ALL_ROLES) {
      expect(navigationForRole(role).length).toBeGreaterThan(0);
    }
  });

  it("every entry is reachable by at least one role and claims a unique href", () => {
    const hrefs = NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);

    for (const item of NAV) {
      expect(item.roles.length).toBeGreaterThan(0);
      expect(NAV_GROUPS).toContain(item.group);
    }
  });

  it("every destination in the sidebar is a route the app actually serves", () => {
    // The defect this exists for, observed: "My devices" and the page it links to were
    // built in parallel and disagreed about their own URL — the row said `/me/devices`
    // while the page sat at `app/(app)/my-devices/`. The single sidebar link carrying a
    // compliance obligation (see your devices, withdraw consent — non-negotiables #1
    // and #4) was a 404, and every other link to that screen was fine, so nothing else
    // showed it. The exact-array matrix above passed throughout: it asks who may open a
    // door and never whether there is a room behind it.
    //
    // Direction-agnostic on purpose. It does not care which of the two spellings wins,
    // only that the sidebar and the filesystem agree on one.
    const routes = routedPaths();

    // Guards the guard: if the derivation ever returns nothing (a moved `app`
    // directory, a Next convention change), the loop below would pass vacuously.
    expect(routes.has("/")).toBe(true);
    expect(routes.size).toBeGreaterThan(NAV.length);

    for (const item of NAV) {
      expect({ href: item.href, routed: routes.has(item.href) }).toEqual({
        href: item.href,
        routed: true,
      });
    }
  });
});

describe("navigationGroupsForRole", () => {
  it("splits an admin's sidebar into the company and their own record", () => {
    const groups = navigationGroupsForRole("super_admin");

    expect(groups.map((section) => section.group)).toEqual(["workspace", "personal"]);
    expect(groups[1]?.items.map((item) => item.href)).toEqual(["/me", "/my-devices", "/account"]);
  });

  it("drops the empty group rather than returning it, so no rule is drawn over nothing", () => {
    const groups = navigationGroupsForRole("employee");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.group).toBe("personal");
  });

  it("holds exactly the same entries as the flat list for every role", () => {
    for (const role of ALL_ROLES) {
      const flat = navigationForRole(role).map((item) => item.href);
      const grouped = navigationGroupsForRole(role).flatMap((section) =>
        section.items.map((item) => item.href),
      );
      expect(grouped).toEqual(flat);
    }
  });
});

describe("canAccessPath", () => {
  it("lets a manager into a nested detail route under a permitted section", () => {
    expect(canAccessPath("manager", "/people/abc-123/timeline")).toBe(true);
  });

  it("keeps an employee out of a manager section", () => {
    expect(canAccessPath("employee", "/people")).toBe(false);
    expect(canAccessPath("employee", "/devices/xyz")).toBe(false);
  });

  it("keeps a manager out of Settings", () => {
    expect(canAccessPath("manager", "/settings")).toBe(false);
    expect(canAccessPath("super_admin", "/settings")).toBe(true);
  });

  it("does not confuse a prefix for a section — /peoplezone is not /people", () => {
    expect(canAccessPath("employee", "/peoplezone")).toBe(true);
  });

  it("allows anything the nav does not claim, so an unlisted route is not blocked by us", () => {
    expect(canAccessPath("employee", "/some/future/page")).toBe(true);
  });

  it("treats the overview root as manager-only, exactly, not as a prefix of everything", () => {
    expect(canAccessPath("employee", "/")).toBe(false);
    expect(canAccessPath("manager", "/")).toBe(true);
  });

  it("lets every role into their own record", () => {
    for (const role of ALL_ROLES) {
      expect(canAccessPath(role, "/me")).toBe(true);
      expect(canAccessPath(role, "/my-devices")).toBe(true);
      expect(canAccessPath(role, "/my-devices/abc-123")).toBe(true);
      expect(canAccessPath(role, "/account")).toBe(true);
    }
  });

  it("does not let the company Devices page decide who may see their own devices", () => {
    // "/devices" is manager-only and "/my-devices" is everyone's. They share a last
    // segment, and confusing them would either lock an employee out of their own
    // machines or let them read the company's.
    expect(canAccessPath("employee", "/devices")).toBe(false);
    expect(canAccessPath("employee", "/my-devices")).toBe(true);
    // Neither is a prefix of the other under a segment-aware comparison. Matching on
    // the last segment, or on a bare `includes`, is how the two would be conflated —
    // and "/my-devices" starts with the same three characters as "/me", which a
    // `startsWith("/me")` check would happily call the same section.
    expect(isNavActive("/devices", "/my-devices")).toBe(false);
    expect(isNavActive("/me", "/my-devices")).toBe(false);
    expect(navClaimFor("/my-devices")?.href).toBe("/my-devices");
  });

  it("agrees with the sidebar for every role and every destination in it", () => {
    // The invariant that matters: nothing is ever *shown* that the wall then refuses,
    // and nothing a role holds is refused to them.
    for (const role of ALL_ROLES) {
      const visible = new Set(navigationForRole(role).map((item) => item.href));
      for (const item of NAV) {
        expect(canAccessPath(role, item.href)).toBe(visible.has(item.href));
      }
    }
  });
});

describe("navClaimFor / activeNavHref", () => {
  it("marks each personal destination as itself, never one as another", () => {
    expect(activeNavHref("/me")).toBe("/me");
    expect(activeNavHref("/my-devices")).toBe("/my-devices");
    expect(activeNavHref("/my-devices/abc-123")).toBe("/my-devices");
    expect(activeNavHref("/account")).toBe("/account");
  });

  it("lights the parent section for a nested route the sidebar has no entry for", () => {
    // `/settings/restrictions` is a real page with no row of its own — the website
    // restriction rules. Its parent is what should be lit.
    expect(activeNavHref("/settings/restrictions")).toBe("/settings");
  });

  it("never lights two rows at once, for any route the app serves", () => {
    // The invariant `navClaimFor`'s "most specific wins" exists to hold. No pair in
    // `NAV` nests today, so a naive first-match would also pass — which is why this
    // is asserted over every real route rather than over one hand-picked example: it
    // starts doing work the moment someone adds `/settings/restrictions` as an entry,
    // without anyone having to remember to come back and write this test.
    for (const route of routedPaths()) {
      const matches = NAV.filter((item) => isNavActive(item.href, route));
      const claim = activeNavHref(route);

      if (matches.length === 0) {
        expect(claim).toBeNull();
        continue;
      }

      // Exactly one row is marked, and it is the deepest entry that matches — the
      // parent never outranks the child.
      const deepest = matches.reduce((a, b) => (b.href.length > a.href.length ? b : a));
      expect(claim).toBe(deepest.href);
      expect(matches.filter((item) => item.href === claim)).toHaveLength(1);
    }
  });

  it("marks the section a nested workspace route belongs to", () => {
    expect(activeNavHref("/people/abc-123/timeline")).toBe("/people");
  });

  it("marks the root only on the root", () => {
    expect(activeNavHref("/")).toBe("/");
    expect(activeNavHref("/people")).toBe("/people");
  });

  it("marks nothing for a path the sidebar does not claim", () => {
    expect(activeNavHref("/some/future/page")).toBeNull();
    expect(navClaimFor("/peoplezone")).toBeNull();
  });

  it("resolves to a real entry whose roles are the ones canAccessPath applies", () => {
    const claim = navClaimFor("/my-devices");
    expect(claim?.label).toBe("My devices");
    expect(claim?.group).toBe("personal");
  });
});

describe("isNavActive", () => {
  it("highlights the section a nested detail route belongs to", () => {
    expect(isNavActive("/people", "/people/abc-123/timeline")).toBe(true);
  });

  it("does not highlight a section whose href is merely a string prefix", () => {
    // The bug this replaces: startsWith("/me") lit "My activity" on /members.
    expect(isNavActive("/me", "/members")).toBe(false);
    expect(isNavActive("/people", "/peoplezone")).toBe(false);
  });

  it("highlights Overview on the root only, not on every route beneath it", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/", "/people")).toBe(false);
  });
});

describe("landingPathForRole", () => {
  it("sends managers to the overview and employees to their own view", () => {
    expect(landingPathForRole("super_admin")).toBe("/");
    expect(landingPathForRole("manager")).toBe("/");
    expect(landingPathForRole("employee")).toBe("/me");
  });

  it("never lands a role on a page it would then be refused", () => {
    // The reported defect in its general form: sign-in sent everyone to "/", which an
    // employee cannot read, so the first screen of the product was a permission wall.
    for (const role of ALL_ROLES) {
      expect(canAccessPath(role, landingPathForRole(role))).toBe(true);
    }
  });

  it("lands every role on a destination their own sidebar carries", () => {
    // Otherwise the landing page is a section with nothing highlighted in the nav,
    // which reads as being dropped somewhere outside the app.
    for (const role of ALL_ROLES) {
      const hrefs = navigationForRole(role).map((item) => item.href);
      expect(hrefs).toContain(landingPathForRole(role));
    }
  });
});

describe("isPublicPath", () => {
  it("treats the login route and its children as public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login/")).toBe(true);
    expect(isPublicPath("/login/callback")).toBe(true);
  });

  it("does not treat a lookalike prefix as public", () => {
    expect(isPublicPath("/loginish")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/people")).toBe(false);
  });

  it("lets both halves of password recovery through unauthenticated", () => {
    // Somebody who cannot sign in is by definition not signed in. /reset-password in
    // particular has to be public because Supabase puts the recovery session in the
    // URL *fragment*, which a browser never sends to a server — so the middleware
    // cannot see it and would bounce the emailed link to /login.
    expect(isPublicPath("/forgot-password")).toBe(true);
    expect(isPublicPath("/reset-password")).toBe(true);
  });

  it("keeps /set-password behind a session", () => {
    // The opposite of the two above, and the distinction matters. Recovery is for
    // people with no session; the forced change is for somebody who has just signed
    // in with a temporary password. Making it public would let anyone open the page,
    // and `updateUser` there acts on whoever's session the browser happens to hold.
    expect(isPublicPath("/set-password")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("returns a same-origin path unchanged, query included", () => {
    expect(safeNextPath("/people?department=eng")).toBe("/people?department=eng");
  });

  it("defaults to the root when there is nothing to return to", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });

  it("refuses an absolute URL — an open redirect is a phishing primitive", () => {
    expect(safeNextPath("https://evil.example/steal")).toBe("/");
    expect(safeNextPath("http://evil.example")).toBe("/");
  });

  it("refuses a protocol-relative path, which browsers resolve as another origin", () => {
    expect(safeNextPath("//evil.example/steal")).toBe("/");
  });

  it("refuses a backslash path, which browsers normalise to a double slash", () => {
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("\\/evil.example")).toBe("/");
  });

  it("refuses control characters used to smuggle past a naive prefix check", () => {
    expect(safeNextPath("/\nhttps://evil.example")).toBe("/");
    expect(safeNextPath("/\tfoo")).toBe("/");
  });

  it("never bounces back to the login page itself", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/login?next=%2Flogin")).toBe("/");
  });
});

describe("loginRedirectPath", () => {
  it("preserves the intended destination so the round trip lands where it started", () => {
    expect(loginRedirectPath("/people/abc", "?tab=timeline")).toBe(
      "/login?next=%2Fpeople%2Fabc%3Ftab%3Dtimeline",
    );
  });

  it("omits the parameter entirely when the destination is the root", () => {
    expect(loginRedirectPath("/", "")).toBe("/login");
  });

  it("does not round-trip a destination it would refuse on the way back", () => {
    expect(loginRedirectPath("/login", "")).toBe("/login");
  });
});

describe("roleLabel", () => {
  it("renders roles in words a person would use, not database enums", () => {
    expect(roleLabel("super_admin")).toBe("Super Admin");
    expect(roleLabel("manager")).toBe("Manager");
    expect(roleLabel("employee")).toBe("Employee");
  });
});

describe("landingRedirectFor", () => {
  it("sends an employee who lands on the manager Overview to their own page", () => {
    // The reported defect, in one assertion: "I have just enrolled with my employee
    // id but I am not seeing anything near to it." They were on "/".
    expect(landingRedirectFor("employee", "/")).toBe("/me");
  });

  it("leaves the Overview alone for the roles it was built for", () => {
    expect(landingRedirectFor("manager", "/")).toBeNull();
    expect(landingRedirectFor("super_admin", "/")).toBeNull();
  });

  it("redirects only the landing path, so a refused section still explains itself", () => {
    // /settings is super-admin only. An employee who follows a link there gets the
    // shell's explanation, not a silent bounce that looks like a broken link.
    expect(landingRedirectFor("employee", "/settings")).toBeNull();
    expect(landingRedirectFor("employee", "/people")).toBeNull();
    expect(landingRedirectFor("employee", "/me")).toBeNull();
  });

  it("does not treat a path that merely starts with a slash as the landing path", () => {
    expect(landingRedirectFor("employee", "/people/abc")).toBeNull();
    expect(landingRedirectFor("employee", "")).toBeNull();
  });

  it("agrees with landingPathForRole for every role", () => {
    for (const role of ["super_admin", "manager", "employee"] as const) {
      const landing = landingPathForRole(role);
      expect(landingRedirectFor(role, "/")).toBe(landing === "/" ? null : landing);
    }
  });
});

describe("PATHNAME_HEADER", () => {
  it("is lower-case, because a header read back from a request always is", () => {
    // `headers().get()` is case-insensitive, but the value middleware writes and the
    // value the layout reads are the same constant precisely so nobody has to know
    // that. Asserting the shape keeps a future rename honest.
    expect(PATHNAME_HEADER).toBe(PATHNAME_HEADER.toLowerCase());
    expect(PATHNAME_HEADER.startsWith("x-")).toBe(true);
  });
});
