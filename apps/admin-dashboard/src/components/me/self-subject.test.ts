import { describe, expect, it } from "vitest";

import type { Session } from "@/lib/session";

import { resolveSelfSubject, selfGreeting } from "./self-subject";

const session: Session = {
  profileId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  companyName: "Acme",
  email: "john@acme.test",
  fullName: "John Smith",
  role: "employee",
  department: "Engineering",
  monitoringEnabled: true,
};

describe("resolveSelfSubject", () => {
  it("reports loading while the session is still being fetched", () => {
    expect(resolveSelfSubject({ session: null, isLoading: true, isError: false })).toEqual({
      state: "loading",
    });
  });

  it("resolves to the signed-in person's own profile", () => {
    expect(resolveSelfSubject({ session, isLoading: false, isError: false })).toEqual({
      state: "ready",
      profileId: session.profileId,
      fullName: "John Smith",
      role: "employee",
      monitoringEnabled: true,
    });
  });

  // The page must never fall back to "some profile" — a self-service screen that
  // renders somebody else's day is the worst failure this product can have.
  it("does not resolve a subject when there is no session", () => {
    expect(resolveSelfSubject({ session: null, isLoading: false, isError: false })).toEqual({
      state: "signed-out",
    });
  });

  it("reports an error state when the session request failed", () => {
    expect(resolveSelfSubject({ session: null, isLoading: false, isError: true })).toEqual({
      state: "error",
    });
  });

  // Loading wins over error: a refetch in flight after a transient failure should
  // show a skeleton, not an error the reader can do nothing about.
  it("prefers loading over error while a retry is in flight", () => {
    expect(resolveSelfSubject({ session: null, isLoading: true, isError: true })).toEqual({
      state: "loading",
    });
  });

  // Non-negotiable #3 is about employees, but a manager opening "My activity"
  // is reading their own data too and must get the same screen.
  it("resolves for a manager and a super admin, not only an employee", () => {
    for (const role of ["manager", "super_admin"] as const) {
      const result = resolveSelfSubject({
        session: { ...session, role },
        isLoading: false,
        isError: false,
      });
      expect(result).toMatchObject({ state: "ready", role });
    }
  });

  // The paused badge is the single most important fact on a page with no data on it.
  it("carries the paused flag through so the screen can explain an empty day", () => {
    const result = resolveSelfSubject({
      session: { ...session, monitoringEnabled: false },
      isLoading: false,
      isError: false,
    });
    expect(result).toMatchObject({ state: "ready", monitoringEnabled: false });
  });
});

describe("selfGreeting", () => {
  it("greets by first name only", () => {
    expect(selfGreeting("John Smith")).toBe("John");
  });

  it("collapses surrounding whitespace rather than greeting an empty string", () => {
    expect(selfGreeting("  Ada  Lovelace ")).toBe("Ada");
  });

  it("falls back to a neutral greeting when the name is blank", () => {
    expect(selfGreeting("")).toBe("there");
    expect(selfGreeting("   ")).toBe("there");
  });

  // A single-word name is common and must not produce an empty greeting.
  it("handles a single-word name", () => {
    expect(selfGreeting("Prince")).toBe("Prince");
  });
});
