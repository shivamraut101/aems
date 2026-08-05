import { describe, expect, it } from "vitest";

import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  describePasswordFailure,
  passwordByteLength,
  passwordChangeSchema,
} from "./password";

function issues(values: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Record<string, string> {
  const parsed = passwordChangeSchema.safeParse(values);
  if (parsed.success) return {};

  const found: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? "form");
    found[field] ??= issue.message;
  }
  return found;
}

describe("passwordChangeSchema", () => {
  it("accepts a change that satisfies every stated rule", () => {
    const parsed = passwordChangeSchema.safeParse({
      currentPassword: "aems-demo-2026",
      newPassword: "a-longer-one-2026",
      confirmPassword: "a-longer-one-2026",
    });

    expect(parsed.success).toBe(true);
  });

  it("requires the current password, because a live session is not proof of identity", () => {
    expect(
      issues({ currentPassword: "", newPassword: "abcdefgh", confirmPassword: "abcdefgh" }),
    ).toHaveProperty("currentPassword");
  });

  /** The same floor the API applies to a first password (`temporaryPassword.min(8)`). */
  it("enforces the same minimum length the API does", () => {
    const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(issues({ currentPassword: "x", newPassword: short, confirmPassword: short })).toHaveProperty(
      "newPassword",
    );

    const exact = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(issues({ currentPassword: "x", newPassword: exact, confirmPassword: exact })).toEqual({});
  });

  /**
   * bcrypt truncates past 72 **bytes**, so a 72-character password of multi-byte
   * characters is silently shortened by the hash. Counting code points — which a plain
   * `.max(72)` does — would accept exactly the password that is quietly weaker than it
   * looks.
   */
  it("counts bytes, not characters, against the hash limit", () => {
    const multibyte = "é".repeat(40); // 40 characters, 80 bytes
    expect(multibyte.length).toBeLessThan(PASSWORD_MAX_BYTES);
    expect(passwordByteLength(multibyte)).toBeGreaterThan(PASSWORD_MAX_BYTES);

    expect(
      issues({ currentPassword: "x", newPassword: multibyte, confirmPassword: multibyte }),
    ).toHaveProperty("newPassword");
  });

  it("accepts a password sitting exactly on the byte limit", () => {
    const exact = "a".repeat(PASSWORD_MAX_BYTES);
    expect(issues({ currentPassword: "x", newPassword: exact, confirmPassword: exact })).toEqual({});
  });

  it("refuses a new password identical to the current one", () => {
    const same = "aems-demo-2026";
    const found = issues({ currentPassword: same, newPassword: same, confirmPassword: same });

    expect(found["newPassword"]).toContain("not already using");
  });

  it("attaches the mismatch to the confirmation field, not to the new-password field", () => {
    const found = issues({
      currentPassword: "x",
      newPassword: "abcdefgh",
      confirmPassword: "abcdefgi",
    });

    expect(found["confirmPassword"]).toContain("do not match");
    expect(found["newPassword"]).toBeUndefined();
  });

  it("publishes the rules as prose, so the form can state them before the field", () => {
    expect(PASSWORD_RULES.join(" ")).toContain(String(PASSWORD_MIN_LENGTH));
    expect(PASSWORD_RULES.length).toBeGreaterThan(1);
  });
});

describe("describePasswordFailure", () => {
  it("names a wrong current password as exactly that", () => {
    expect(describePasswordFailure("reauthenticate", "Invalid login credentials")).toBe(
      "That is not your current password.",
    );
  });

  it("does not blame the current password when the update itself failed", () => {
    const message = describePasswordFailure("update", "New password should be different from the old password");
    expect(message).toBe("Choose a password you are not already using.");
  });

  it("reports a rate limit as a wait rather than as a wrong password", () => {
    expect(describePasswordFailure("reauthenticate", "Request rate limit reached")).toContain(
      "Wait a minute",
    );
  });

  it("reports a dropped connection as a connection problem", () => {
    expect(describePasswordFailure("update", "Failed to fetch")).toContain("connection");
  });

  it("tells someone whose session died while typing what to do", () => {
    expect(describePasswordFailure("update", "JWT expired")).toContain("Sign in again");
  });

  it("falls back to a sentence rather than to a raw driver string", () => {
    const message = describePasswordFailure("update", "unexpected_failure: 42");
    expect(message).not.toContain("42");
  });
});
