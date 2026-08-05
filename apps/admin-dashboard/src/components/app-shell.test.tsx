// @vitest-environment jsdom

/**
 * The shell's navigation, rendered.
 *
 * `session.test.ts` proves the role matrix as data — who *may* see what. This proves
 * the shell actually draws it, which is a different question and the one the client
 * reported: below 768px the only `<nav>` in the app is `hidden … md:flex`, so on a
 * phone the product had no navigation at all. No home link, no way to change section
 * short of editing the URL, and no way to sign out, because the session card lives
 * inside that same hidden element.
 *
 * Rendered with `react-dom/client` directly — there is no testing-library in this
 * repo and this is the first component test in the dashboard, so it brings its own
 * two-line harness rather than a dependency the locked stack does not list.
 */

// Imported as a namespace because the dashboard's tsconfig sets `jsx: "preserve"` for
// Next, so Vitest's esbuild emits classic `React.createElement` calls rather than the
// automatic runtime. Without this the JSX below is a `ReferenceError` at render time.
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { navigationForRole } from "@/lib/session";
import type { Session, UserRole } from "@/lib/session";

/**
 * `vi.hoisted` because `vi.mock` factories are lifted above the imports: a plain
 * `const` declared here would still be in its temporal dead zone when the factory runs.
 */
const routing = vi.hoisted(() => ({ pathname: "/me" }));

vi.mock("next/navigation", () => ({
  usePathname: () => routing.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      react.createElement("a", { href, ...rest }, children),
  };
});

// The query is deliberately silent here. `initialSession` is the server's answer and
// the component must render it without waiting for anything — that is the whole fix
// for the placeholder bars, so the test starves the query to prove it.
vi.mock("@/lib/api", () => ({ useSession: () => ({ data: undefined }) }));

vi.mock("@/lib/supabase", () => ({
  createClient: () => ({ auth: { signOut: vi.fn().mockResolvedValue(undefined) } }),
}));

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ clear: vi.fn() }) }));

/**
 * The dashboard's tsconfig sets `jsx: "preserve"` — Next compiles JSX itself, with the
 * automatic runtime. Vitest's esbuild sees `preserve`, falls back to the *classic*
 * transform, and emits bare `React.createElement(...)` into every component it loads —
 * including `app-shell.tsx`, which quite correctly does not import React. Publishing
 * React globally is what makes those calls resolve.
 *
 * The tidier fix is `esbuild: { jsx: "automatic" }` in `vitest.config.ts`, which would
 * spare every future component test this line. That file is outside this agent's
 * ownership, so it is flagged for the integrator rather than edited here.
 *
 * Must run before `app-shell` is imported, hence the dynamic import below.
 */
(globalThis as { React?: typeof React }).React = React;

const { AppShell } = await import("./app-shell");

function sessionFor(role: UserRole): Session {
  return {
    profileId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    companyName: "Acme Corp",
    email: "person@aems.local",
    fullName: "Ada Lovelace",
    role,
    department: "Engineering",
    monitoringEnabled: true,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 refuses to run `act` without this, and silently double-warns without it.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  routing.pathname = "/me";
});

function render(session: Session | null, pathname = "/me") {
  routing.pathname = pathname;
  act(() => {
    root.render(<AppShell initialSession={session}>{<p>page body</p>}</AppShell>);
  });
}

/** Every `<nav aria-label="Main">` on the page — the sidebar, and the drawer if open. */
function navigations(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('nav[aria-label="Main"]')];
}

/**
 * The destination labels, scoped to the list items.
 *
 * Not every `<a>` inside the sidebar is a destination: the wordmark is a link home and
 * the session card can render a "Sign in" link, and neither belongs in the comparison.
 * The two navigations also differ in what they wrap — the sidebar's `<nav>` holds the
 * wordmark and session card as well, the drawer keeps them outside it — so scoping to
 * `li` is what lets the two be compared at all.
 */
function labelsIn(nav: HTMLElement): string[] {
  return [...nav.querySelectorAll("li a")].map((link) => link.textContent?.trim() ?? "");
}

function menuButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
}

describe("the sidebar", () => {
  it("renders the role's destinations on the first paint, with no placeholder bars", () => {
    render(sessionFor("super_admin"));

    const sidebar = navigations()[0];
    expect(sidebar).toBeDefined();
    expect(labelsIn(sidebar!)).toEqual(
      navigationForRole("super_admin").map((item) => item.label),
    );
    // The defect this replaced: four grey bars that swapped to the real rows once the
    // session query answered. The query is mocked as unanswered above, so if anything
    // still waited on it there would be nothing to assert against.
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("is hidden below the breakpoint the mobile header appears at", () => {
    render(sessionFor("manager"));

    const sidebar = navigations()[0]!;
    // The two halves of the same decision. If these ever disagree a viewport exists
    // with either two navigations or none — the reported bug is the "none" case.
    expect(sidebar.className).toContain("hidden");
    expect(sidebar.className).toContain("md:flex");
    expect(menuButton()?.closest("header")?.className).toContain("md:hidden");
  });

  it("gives an employee their own three destinations and nothing of the company's", () => {
    render(sessionFor("employee"));

    expect(labelsIn(navigations()[0]!)).toEqual(["My activity", "My devices", "Account"]);
  });
});

describe("the mobile drawer", () => {
  it("exists at all — a phone had no navigation before it", () => {
    render(sessionFor("employee"));
    expect(menuButton()).not.toBeNull();
  });

  it("opens the same destinations the sidebar carries, for every role", () => {
    for (const role of ["super_admin", "manager", "employee"] as const) {
      render(sessionFor(role));

      const sidebarLabels = labelsIn(navigations()[0]!);
      act(() => menuButton()!.click());

      // Radix portals the drawer to the body, so it is a second `nav[aria-label=Main]`.
      const navs = navigations();
      expect(navs).toHaveLength(2);
      expect(labelsIn(navs[1]!)).toEqual(sidebarLabels);
      expect(sidebarLabels).toEqual(navigationForRole(role).map((item) => item.label));

      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("carries the way out, which the hidden sidebar was holding hostage", () => {
    // Sign out lives in the session card at the foot of the sidebar. Below `md` that
    // element is display:none, so without the drawer there was no way to leave.
    render(sessionFor("employee"));
    act(() => menuButton()!.click());

    const drawer = document.querySelector('[role="dialog"]');
    expect(drawer?.textContent).toContain("Sign out");
    expect(drawer?.textContent).toContain("Ada Lovelace");
  });

  it("marks exactly one destination as current, matching the sidebar", () => {
    render(sessionFor("super_admin"), "/people/abc-123/timeline");
    act(() => menuButton()!.click());

    for (const nav of navigations()) {
      const current = [...nav.querySelectorAll('a[aria-current="page"]')];
      expect(current).toHaveLength(1);
      expect(current[0]?.textContent?.trim()).toBe("People");
    }
  });

  it("opens focus on the first destination, not on Sign out", () => {
    // Radix's default focuses the first *non-link* tabbable, on the reasoning that a
    // link is rarely a dialog's primary action. In a drawer made entirely of links the
    // first non-link is Sign out — so opening the menu and pressing Enter signed the
    // person out.
    render(sessionFor("employee"));
    act(() => menuButton()!.click());

    const focused = document.activeElement;
    expect(focused?.tagName).toBe("A");
    expect(focused?.textContent?.trim()).toBe("My activity");
  });
});

describe("no session", () => {
  it("still renders the page rather than an empty frame", () => {
    render(null);
    expect(container.textContent).toContain("page body");
  });
});
