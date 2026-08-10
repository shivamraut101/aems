import { describe, expect, it } from "vitest";

import { resolveRestrictions, ruleIdOf } from "./website-restrictions.js";

const on = { enabled: true, mode: "blocklist", notice: "Ask IT", revision: 4 };

const rule = (over: Partial<Parameters<typeof resolveRestrictions>[1][number]> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  action: "block",
  match_kind: "domain",
  pattern: "facebook.com",
  note: "Not needed for your role",
  enabled: true,
  ...over,
});

describe("resolveRestrictions", () => {
  it("maps an enabled domain block to the shape the extension enforces", () => {
    const out = resolveRestrictions(on, [rule()]);

    expect(out.rules).toEqual([
      { id: ruleIdOf("11111111-1111-4111-8111-111111111111"), domain: "facebook.com", reason: "Not needed for your role" },
    ]);
    expect(out.contact).toBe("Ask IT");
    expect(out.revision).toBe(4);
    expect(out.unenforceable).toBe(0);
  });

  it("enforces nothing when the control is switched off, without discarding the rules", () => {
    // The rules stay authored in the database — an admin turning restriction off and
    // on again must not have to retype their list.
    const out = resolveRestrictions({ ...on, enabled: false }, [rule()]);
    expect(out.rules).toEqual([]);
  });

  it("drops a disabled rule", () => {
    expect(resolveRestrictions(on, [rule({ enabled: false })]).rules).toEqual([]);
  });

  /**
   * The two that must never be squeezed into `{ domain }`. A URL pattern sent as a host
   * refuses the wrong pages, and an `allow` rule in a list the extension reads as
   * "refuse these" inverts its own meaning.
   */
  it("refuses to mangle a url_pattern into a domain, and counts it", () => {
    const out = resolveRestrictions(on, [rule({ match_kind: "url_pattern", pattern: "*/admin/*" })]);
    expect(out.rules).toEqual([]);
    expect(out.unenforceable).toBe(1);
  });

  it("drops an allow rule and counts it", () => {
    const out = resolveRestrictions(on, [rule({ action: "allow" })]);
    expect(out.rules).toEqual([]);
    expect(out.unenforceable).toBe(1);
  });

  /**
   * Allowlist inverts the list. Handing an inverted list to something that treats it as
   * a blocklist would refuse exactly the sites that are permitted, so it fails open and
   * reports everything as unenforceable.
   */
  it("enforces nothing in allowlist mode rather than inverting the meaning", () => {
    const out = resolveRestrictions({ ...on, mode: "allowlist" }, [rule(), rule({ id: "b" })]);
    expect(out.rules).toEqual([]);
    expect(out.unenforceable).toBe(2);
  });

  it("treats a missing settings row as nothing enforced", () => {
    expect(resolveRestrictions(null, [rule()])).toMatchObject({ rules: [], revision: 0 });
  });
});

describe("ruleIdOf", () => {
  it("is stable, positive and distinct — declarativeNetRequest needs all three", () => {
    const a = ruleIdOf("11111111-1111-4111-8111-111111111111");
    expect(a).toBe(ruleIdOf("11111111-1111-4111-8111-111111111111"));
    expect(a).toBeGreaterThan(0);
    expect(a).not.toBe(ruleIdOf("22222222-2222-4222-8222-222222222222"));
    expect(Number.isSafeInteger(a)).toBe(true);
  });

  /**
   * The id has to survive a rule being deleted from above it — an array index would
   * not, and the browser diffs its own rule set by id.
   */
  it("does not depend on position", () => {
    const ids = ["a", "b", "c"].map(ruleIdOf);
    expect(["c", "a", "b"].map(ruleIdOf)).toEqual([ids[2], ids[0], ids[1]]);
  });
});
