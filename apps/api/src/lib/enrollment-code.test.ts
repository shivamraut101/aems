import { describe, expect, it } from "vitest";

import { codeRejection, generateCode, hashCode, normaliseCode } from "./enrollment-code.js";

describe("generateCode", () => {
  it("is formatted the way the dialog prints it", () => {
    expect(generateCode()).toMatch(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
  });

  it("omits every character that is misread when copied by hand", () => {
    // 0/O, 1/I/L and U are the ones people get wrong reading off a screen or a photo.
    // Each would surface as "the code doesn't work" rather than as a typo.
    const codes = Array.from({ length: 200 }, () => generateCode()).join("");
    for (const banned of ["O", "0", "I", "1", "U"]) {
      expect(codes.includes(banned), `alphabet must not contain ${banned}`).toBe(false);
    }
  });

  it("does not repeat", () => {
    // Not a randomness proof — a guard against someone replacing randInt with a
    // counter or a fixed seed, which would make every code the same one.
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(seen.size).toBe(500);
  });
});

describe("normaliseCode", () => {
  it("accepts every shape a person types the same code in", () => {
    const canonical = normaliseCode("K7P2-9WQX");
    for (const variant of ["k7p2-9wqx", "K7P2 9WQX", "K7P29WQX", "  K7P2-9WQX\n", "k7p2 9wqx  "]) {
      expect(normaliseCode(variant), variant).toBe(canonical);
    }
  });

  it("does not fold characters that are genuinely different", () => {
    expect(normaliseCode("K7P2-9WQX")).not.toBe(normaliseCode("K7P2-9WQZ"));
  });
});

describe("hashCode", () => {
  it("agrees across the formats normaliseCode accepts", () => {
    // The redemption lookup is by hash. If casing changed the hash, a code typed in
    // lower case would simply not be found — and the failure would read as "invalid
    // code" rather than as a bug.
    expect(hashCode("k7p2 9wqx")).toBe(hashCode("K7P2-9WQX"));
  });

  it("is a hex sha-256, not the code itself", () => {
    const hash = hashCode("K7P2-9WQX");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("K7P2");
  });
});

describe("codeRejection", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");
  const live = { expires_at: "2026-08-05T12:05:00Z", consumed_at: null };

  it("accepts a live, unused code", () => {
    expect(codeRejection(live, now)).toBeNull();
  });

  it("refuses one that was already redeemed", () => {
    expect(codeRejection({ ...live, consumed_at: "2026-08-05T11:59:00Z" }, now)?.statusCode).toBe(401);
  });

  it("refuses one that has expired", () => {
    expect(codeRejection({ ...live, expires_at: "2026-08-05T11:59:59Z" }, now)?.statusCode).toBe(401);
  });

  it("treats the exact expiry instant as expired", () => {
    // `<=`, not `<`. A code whose expiry is exactly now is over, and an off-by-one
    // here is the kind of thing that only ever shows up as a flaky enrolment.
    expect(codeRejection({ ...live, expires_at: "2026-08-05T12:00:00Z" }, now)?.statusCode).toBe(401);
  });

  it("refuses a code that does not exist", () => {
    expect(codeRejection(null, now)?.statusCode).toBe(401);
  });

  it("says exactly the same thing for missing, used and expired", () => {
    // Distinguishing them turns the endpoint into an oracle: an attacker could
    // enumerate which codes exist by the wording. None of the three is separately
    // actionable anyway — the fix is always "get a new code".
    const messages = new Set(
      [
        codeRejection(null, now),
        codeRejection({ ...live, consumed_at: "2026-08-05T11:00:00Z" }, now),
        codeRejection({ ...live, expires_at: "2026-08-05T11:00:00Z" }, now),
      ].map((rejection) => `${rejection?.statusCode} ${rejection?.error} ${rejection?.message}`),
    );

    expect(messages.size).toBe(1);
  });
});
