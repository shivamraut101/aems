import { describe, expect, it } from "vitest";

import { displayName, initials, subtitleFor } from "./identity";

describe("displayName", () => {
  it("prefers the full name", () => {
    expect(displayName({ full_name: "John Smith", email: "js@acme.com" })).toBe("John Smith");
  });

  it("falls back to the email local part rather than rendering a blank", () => {
    expect(displayName({ full_name: "", email: "john.smith@acme.com" })).toBe("john.smith");
    expect(displayName({ full_name: "   ", email: "john.smith@acme.com" })).toBe("john.smith");
  });

  it("uses the whole string when there is no local part to take", () => {
    expect(displayName({ full_name: "", email: "operator" })).toBe("operator");
  });
});

describe("initials", () => {
  it("takes the first letter of the first and last words", () => {
    expect(initials("John Smith")).toBe("JS");
    expect(initials("Ada Byron Lovelace")).toBe("AL");
  });

  it("takes two letters from a single word", () => {
    expect(initials("Prince")).toBe("PR");
  });

  it("is upper case whatever it was given", () => {
    expect(initials("john smith")).toBe("JS");
  });

  it("never renders empty — a blank avatar reads as a loading bug", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });

  it("handles non-latin names without slicing a character in half", () => {
    expect(initials("Иван Петров")).toBe("ИП");
  });
});

describe("subtitleFor", () => {
  it("puts the department beside the role when there is one", () => {
    expect(subtitleFor("employee", "Engineering")).toBe("Employee · Engineering");
  });

  it("shows the role alone rather than a trailing separator", () => {
    expect(subtitleFor("manager", null)).toBe("Manager");
    expect(subtitleFor("super_admin", "")).toBe("Super Admin");
  });
});
