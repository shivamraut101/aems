import { describe, expect, it } from "vitest";

import {
  NAV,
  canAccessPath,
  isNavActive,
  isPublicPath,
  landingPathForRole,
  loginRedirectPath,
  navigationForRole,
  parseMeResponse,
  roleLabel,
  safeNextPath,
} from "./session";

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

describe("navigationForRole", () => {
  it("gives a super admin every destination, Settings included", () => {
    const hrefs = navigationForRole("super_admin").map((item) => item.href);
    expect(hrefs).toEqual(NAV.map((item) => item.href));
    expect(hrefs).toContain("/settings");
  });

  it("withholds Settings from a manager but keeps the team destinations", () => {
    const hrefs = navigationForRole("manager").map((item) => item.href);
    expect(hrefs).toContain("/people");
    expect(hrefs).toContain("/reports");
    expect(hrefs).toContain("/insights");
    expect(hrefs).not.toContain("/settings");
  });

  it("leaves an employee only their own view — item 25's named defect", () => {
    const hrefs = navigationForRole("employee").map((item) => item.href);
    expect(hrefs).not.toContain("/devices");
    expect(hrefs).not.toContain("/reports");
    expect(hrefs).not.toContain("/insights");
    expect(hrefs).not.toContain("/people");
    expect(hrefs).toEqual(["/me"]);
  });

  it("never returns an empty sidebar for any role", () => {
    for (const role of ["super_admin", "manager", "employee"] as const) {
      expect(navigationForRole(role).length).toBeGreaterThan(0);
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
