import { describe, expect, it } from "vitest";

import type { EmployeeRow } from "@/lib/api";
import {
  DEFAULT_RULE_PRIORITY,
  MAX_NOTE_LENGTH,
  canonicalDomain,
  domainTallies,
  duplicateRule,
  emptyRestrictionRule,
  modeCopy,
  patternCaution,
  patternProblem,
  personLabel,
  refusalReason,
  rejectionsById,
  restrictionRuleFormFrom,
  restrictionRuleSchema,
  restrictionRuleToInput,
  restrictionSettingsFormFrom,
  restrictionSettingsToInput,
  rulePreview,
  ruleReach,
  rulesById,
  settingsChangeConsequence,
  type RestrictionEvent,
  type RestrictionRule,
} from "@/lib/queries/restrictions";

/**
 * The pure half of website restrictions.
 *
 * Everything asserted here is a decision the UI cannot afford to make twice: what a typed
 * hostname reduces to, what the postures mean, and how a refusal is explained. The hooks
 * and the components are deliberately not exercised — those need the API's routes and a
 * DOM, and this file is what can be proved without either.
 *
 * Several assertions below exist to keep this file honest against
 * `apps/api/src/routes/restrictions.ts`, which owns the contract: the canonical form of a
 * domain, the fact that a blank note must travel as `null` rather than `""` (the API's
 * `note` is `min(1).nullish()`, so `""` is a 400), and the shape of a rule.
 */

function rule(overrides: Partial<RestrictionRule> = {}): RestrictionRule {
  return {
    id: "rule-1",
    priority: DEFAULT_RULE_PRIORITY,
    action: "block",
    matchKind: "domain",
    pattern: "facebook.com",
    note: null,
    enabled: true,
    createdBy: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<RestrictionEvent> = {}): RestrictionEvent {
  return {
    id: 1,
    profileId: "profile-1",
    deviceId: "device-1",
    ruleId: null,
    matchedPattern: null,
    mode: "blocklist",
    domain: "facebook.com",
    url: "https://facebook.com/",
    blockedAt: "2026-08-05T09:00:00.000Z",
    ...overrides,
  };
}

describe("canonicalDomain", () => {
  it("reduces what people actually paste to the host the rule is about", () => {
    expect(canonicalDomain("https://www.facebook.com/groups/123")).toBe("www.facebook.com");
    expect(canonicalDomain("  FACEBOOK.COM  ")).toBe("facebook.com");
    expect(canonicalDomain("facebook.com/")).toBe("facebook.com");
    expect(canonicalDomain("facebook.com.")).toBe("facebook.com");
    expect(canonicalDomain("*.facebook.com")).toBe("facebook.com");
    expect(canonicalDomain("example.com:8443")).toBe("example.com");
  });

  it("drops credentials rather than reading them as the host", () => {
    // `https://evil.com@example.com/` is a request to example.com. A reducer that kept
    // the left-hand side would write a rule about the wrong site.
    expect(canonicalDomain("https://evil.com@example.com/")).toBe("example.com");
  });

  it("refuses what is not a host", () => {
    expect(canonicalDomain("")).toBeNull();
    expect(canonicalDomain("   ")).toBeNull();
    expect(canonicalDomain("ads-*.example.com")).toBeNull();
    expect(canonicalDomain("two words.com")).toBeNull();
  });

  it("is idempotent, so a stored pattern reduces to itself", () => {
    for (const raw of ["facebook.com", "app.example.co.uk", "localhost"]) {
      const once = canonicalDomain(raw);
      expect(once).not.toBeNull();
      expect(canonicalDomain(once!)).toBe(once);
    }
  });
});

describe("patternProblem", () => {
  it("names the mistake instead of saying invalid", () => {
    expect(patternProblem("domain", "")).toMatch(/Enter a website/);
    expect(patternProblem("domain", "ads-*.example.com")).toMatch(/URL pattern/);
    expect(patternProblem("domain", "facebook.com twitter.com")).toMatch(/one address/);
  });

  it("accepts anything the reducer can reduce", () => {
    expect(patternProblem("domain", "https://www.facebook.com/groups/1")).toBeNull();
    expect(patternProblem("domain", "GitHub.com")).toBeNull();
  });

  it("never refuses what the API's matcher accepts", () => {
    // The API validates a pattern by *compiling* it with the matcher the extension runs,
    // and it accepts a single-label host — `intranet` is a real hostname on a corporate
    // LAN. A client validator stricter than the server refuses work the product supports,
    // which is worse than a round trip. Anything subtler must reach the server so its own
    // sentence is what gets shown.
    expect(patternProblem("domain", "intranet")).toBeNull();
    expect(patternProblem("url_pattern", "example.com/admin*")).toBeNull();
    expect(patternProblem("url_pattern", "*.ads.example.com")).toBeNull();
    expect(patternProblem("url_pattern", "https://example.com:8443/x")).toBeNull();
    expect(patternProblem("url_pattern", "admin")).toBeNull();
  });

  it("refuses a pattern longer than the column allows before the API has to", () => {
    expect(patternProblem("domain", `${"a".repeat(400)}.com`)).toMatch(/longer than 400/);
  });
});

describe("patternCaution", () => {
  it("flags the typo that compiles cleanly and matches nothing", () => {
    // `facebook` is a legal hostname, so nothing refuses it — and it will never match a
    // page anyone visits. In the table it is indistinguishable from a working rule.
    expect(patternCaution("domain", "facebook")).toMatch(/single-word host/);
    expect(patternCaution("url_pattern", "admin/users")).toMatch(/single-word host/);
  });

  it("stays quiet for an ordinary pattern", () => {
    expect(patternCaution("domain", "facebook.com")).toBeNull();
    expect(patternCaution("url_pattern", "example.com/admin*")).toBeNull();
    expect(patternCaution("url_pattern", "*.ads.example.com")).toBeNull();
    expect(patternCaution("domain", "")).toBeNull();
  });
});

describe("ruleReach", () => {
  it("says that a website rule covers subdomains, because the matcher does", () => {
    // `hostMatchesDomain` in the API suffix-matches at a label boundary: a domain rule
    // always covers subdomains. There is no per-rule switch, so the copy must not imply
    // one exists.
    expect(ruleReach(rule({ pattern: "facebook.com" }))).toBe(
      "facebook.com and every subdomain of it",
    );
  });

  it("quotes a URL pattern rather than paraphrasing it", () => {
    expect(ruleReach(rule({ matchKind: "url_pattern", pattern: "example.com/admin*" }))).toBe(
      "URLs matching example.com/admin*",
    );
  });
});

describe("rulePreview", () => {
  it("says plainly what a block rule does under a block list", () => {
    expect(rulePreview("blocklist", { action: "block", matchKind: "domain", pattern: "facebook.com" }))
      .toBe("Employees will not be able to open facebook.com and every subdomain of it.");
  });

  /**
   * The two combinations people get wrong, and the reason this function exists. Both
   * produce a rule that changes nothing on its own, and the table cannot tell that
   * apart from a rule that works.
   */
  it("explains a rule that only takes effect against another rule", () => {
    const allowUnderBlocklist = rulePreview("blocklist", {
      action: "allow",
      matchKind: "domain",
      pattern: "facebook.com",
    });
    expect(allowUnderBlocklist).toMatch(/even if a block rule/);

    const blockUnderAllowlist = rulePreview("allowlist", {
      action: "block",
      matchKind: "domain",
      pattern: "facebook.com",
    });
    expect(blockUnderAllowlist).toMatch(/stays refused/);
  });

  it("states the allow list's default alongside an allow rule", () => {
    const text = rulePreview("allowlist", {
      action: "allow",
      matchKind: "domain",
      pattern: "payroll.example.com",
    });
    expect(text).toMatch(/will be able to open payroll\.example\.com/);
    expect(text).toMatch(/not allowed by some rule stays refused/);
  });

  it("quotes a URL pattern rather than paraphrasing it", () => {
    expect(
      rulePreview("blocklist", {
        action: "block",
        matchKind: "url_pattern",
        pattern: "example.com/admin*",
      }),
    ).toBe("Employees will not be able to open URLs matching example.com/admin*.");
  });

  it("says nothing until the pattern is usable", () => {
    // A preview built from half a hostname reads as a statement about a site nobody
    // named, which is worse than no preview.
    expect(rulePreview("blocklist", { action: "block", matchKind: "domain", pattern: "" })).toBeNull();
    expect(
      rulePreview("blocklist", { action: "block", matchKind: "domain", pattern: "ads-*.example.com" }),
    ).toBeNull();
  });
});

describe("modeCopy", () => {
  it("states the consequence of each posture rather than naming it", () => {
    expect(modeCopy("blocklist").summary).toMatch(/except/);
    expect(modeCopy("allowlist").summary).toMatch(/Only the websites/);
  });
});

describe("settingsChangeConsequence", () => {
  const off = { enabled: false, mode: "blocklist" } as const;
  const block = { enabled: true, mode: "blocklist" } as const;
  const allow = { enabled: true, mode: "allowlist" } as const;

  it("warns about the change that can strand a whole company", () => {
    const text = settingsChangeConsequence(allow, block, 3);
    expect(text).toMatch(/stops opening/);
    expect(text).toMatch(/3 rules are written/);
    // Named examples, because the sites that break under an allow list are the ones
    // nobody thought to list.
    expect(text).toMatch(/payroll/);
  });

  it("treats switching enforcement on as consequential too", () => {
    expect(settingsChangeConsequence(block, off, 2)).toMatch(/start being enforced/);
    expect(settingsChangeConsequence(allow, off, 2)).toMatch(/stops opening/);
  });

  it("says what switching enforcement off does, including that rules are kept", () => {
    const text = settingsChangeConsequence(off, allow, 2);
    expect(text).toMatch(/starts opening again/);
    expect(text).toMatch(/rules are kept/);
  });

  it("stays silent when only the message changed", () => {
    // A confirmation for a copy edit teaches people to click through confirmations.
    expect(settingsChangeConsequence(block, block, 4)).toBeNull();
    expect(settingsChangeConsequence(off, off, 4)).toBeNull();
  });

  it("stays silent about a mode change made while enforcement is off", () => {
    // No browser behaves differently, so announcing "every website starts opening again"
    // would describe a change to devices that are not being filtered at all.
    const offAllow = { enabled: false, mode: "allowlist" } as const;
    expect(settingsChangeConsequence(offAllow, off, 4)).toBeNull();
    expect(settingsChangeConsequence(off, offAllow, 4)).toBeNull();
  });

  it("says one rule in the singular", () => {
    expect(settingsChangeConsequence(allow, block, 1)).toMatch(/1 rule is written/);
  });
});

describe("the rule form", () => {
  it("defaults to the action that matches the company's posture", () => {
    expect(emptyRestrictionRule("blocklist").action).toBe("block");
    expect(emptyRestrictionRule("allowlist").action).toBe("allow");
    // A whole-site rule is what people mean; it also covers the mobile host, and a rule
    // that missed m.facebook.com would look broken.
    expect(emptyRestrictionRule("blocklist").matchKind).toBe("domain");
  });

  it("round-trips an existing rule without losing a field", () => {
    const existing = rule({ note: "Ask your manager", priority: 5, action: "allow" });
    expect(restrictionRuleFormFrom(existing)).toEqual({
      matchKind: "domain",
      action: "allow",
      pattern: "facebook.com",
      priority: 5,
      note: "Ask your manager",
      enabled: true,
    });
  });

  it("sends a blank reason as null, never as an empty string", () => {
    // The API's `note` is `z.string().trim().min(1).nullish()`. Sending "" is a 400 for a
    // box the person deliberately left empty.
    const input = restrictionRuleToInput({ ...emptyRestrictionRule("blocklist"), pattern: "x.com" });
    expect(input.note).toBeNull();
    expect(restrictionRuleToInput({
      ...emptyRestrictionRule("blocklist"),
      pattern: "x.com",
      note: "   ",
    }).note).toBeNull();
  });

  it("canonicalises a website rule so the row shows what was saved", () => {
    const input = restrictionRuleToInput({
      ...emptyRestrictionRule("blocklist"),
      pattern: "  HTTPS://WWW.Facebook.com/groups/1  ",
    });
    expect(input.pattern).toBe("www.facebook.com");
  });

  it("leaves a URL pattern's case alone beyond trimming", () => {
    // `compileUrlPattern` lower-cases for matching, so the stored text does not need to —
    // and rewriting it would misrepresent what the admin wrote.
    const input = restrictionRuleToInput({
      ...emptyRestrictionRule("blocklist"),
      matchKind: "url_pattern",
      pattern: "  example.com/Admin*  ",
    });
    expect(input.pattern).toBe("example.com/Admin*");
  });

  it("refuses a pattern the person can fix and a reason longer than the column", () => {
    const bad = restrictionRuleSchema.safeParse({
      ...emptyRestrictionRule("blocklist"),
      pattern: "ads-*.example.com",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.path).toEqual(["pattern"]);
    }

    const longNote = restrictionRuleSchema.safeParse({
      ...emptyRestrictionRule("blocklist"),
      pattern: "facebook.com",
      note: "n".repeat(MAX_NOTE_LENGTH + 1),
    });
    expect(longNote.success).toBe(false);
  });

  it("refuses an order outside what the API accepts", () => {
    const negative = restrictionRuleSchema.safeParse({
      ...emptyRestrictionRule("blocklist"),
      pattern: "facebook.com",
      priority: -1,
    });
    expect(negative.success).toBe(false);

    const fractional = restrictionRuleSchema.safeParse({
      ...emptyRestrictionRule("blocklist"),
      pattern: "facebook.com",
      priority: 1.5,
    });
    expect(fractional.success).toBe(false);
  });

  it("accepts a well-formed rule", () => {
    const parsed = restrictionRuleSchema.safeParse({
      ...emptyRestrictionRule("blocklist"),
      pattern: "https://facebook.com",
      note: "Ask your manager if you need access.",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("duplicateRule", () => {
  const rules = [rule({ id: "a", pattern: "facebook.com" })];

  it("recognises the same site written differently", () => {
    expect(
      duplicateRule(rules, { matchKind: "domain", pattern: "HTTPS://Facebook.com/x" }, null)?.id,
    ).toBe("a");
  });

  it("ignores the rule being edited", () => {
    expect(duplicateRule(rules, { matchKind: "domain", pattern: "facebook.com" }, "a")).toBeNull();
  });

  it("does not confuse a URL pattern with a website rule of the same text", () => {
    // They mean different things to the matcher and the API's uniqueness constraint is
    // per pattern; treating them as the same would block a legitimate narrowing rule.
    expect(
      duplicateRule(rules, { matchKind: "url_pattern", pattern: "facebook.com" }, null),
    ).toBeNull();
  });

  it("says nothing about an unusable pattern", () => {
    expect(duplicateRule(rules, { matchKind: "domain", pattern: "" }, null)).toBeNull();
  });
});

describe("the settings form", () => {
  it("round-trips, and sends a blank message as null", () => {
    const form = restrictionSettingsFormFrom({
      enabled: true,
      mode: "allowlist",
      notice: null,
      revision: 3,
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    expect(form).toEqual({ enabled: true, mode: "allowlist", notice: "" });
    expect(restrictionSettingsToInput(form)).toEqual({
      enabled: true,
      mode: "allowlist",
      notice: null,
    });
  });

  it("keeps a written message, trimmed", () => {
    expect(
      restrictionSettingsToInput({ enabled: true, mode: "blocklist", notice: "  Ask IT.  " })
        .notice,
    ).toBe("Ask IT.");
  });
});

describe("domainTallies", () => {
  it("counts requests but reports distinct people", () => {
    const tallies = domainTallies([
      event({ id: 1, domain: "facebook.com", profileId: "p1" }),
      event({ id: 2, domain: "facebook.com", profileId: "p1" }),
      event({ id: 3, domain: "facebook.com", profileId: "p2" }),
      event({ id: 4, domain: "reddit.com", profileId: "p3" }),
    ]);

    expect(tallies[0]).toEqual({ domain: "facebook.com", count: 3, people: 2 });
    expect(tallies[1]).toEqual({ domain: "reddit.com", count: 1, people: 1 });
  });

  it("is stable when two domains tie", () => {
    const tallies = domainTallies([event({ id: 1, domain: "b.com" }), event({ id: 2, domain: "a.com" })]);
    expect(tallies.map((t) => t.domain)).toEqual(["a.com", "b.com"]);
  });

  it("does not drop a refusal whose address could not be read", () => {
    const tallies = domainTallies([event({ domain: null })]);
    expect(tallies[0]?.count).toBe(1);
  });

  it("honours the limit", () => {
    const events = ["a", "b", "c", "d", "e", "f"].map((d, i) =>
      event({ id: i, domain: `${d}.com` }),
    );
    expect(domainTallies(events, 2)).toHaveLength(2);
    expect(domainTallies(events, 0)).toHaveLength(0);
  });
});

describe("refusalReason", () => {
  const byId = rulesById([rule({ id: "a", pattern: "facebook.com" })]);

  it("names the rule that decided", () => {
    expect(refusalReason(event({ ruleId: "a" }), byId)).toBe("Rule: facebook.com");
  });

  it("treats an allow list's default as a normal reason, not a fault", () => {
    // Under an allow list this is *the* usual reason, and naming it that way is what
    // makes the row something an admin can act on.
    expect(refusalReason(event({ mode: "allowlist", ruleId: null }), byId)).toBe(
      "No rule allows it",
    );
  });

  it("falls back to the pattern the event recorded when the rule is gone", () => {
    expect(refusalReason(event({ ruleId: "gone", matchedPattern: "old.com" }), byId)).toBe(
      "Rule since removed: old.com",
    );
    expect(refusalReason(event({ ruleId: "gone" }), byId)).toBe(
      "A rule that has since been removed",
    );
  });
});

describe("rejectionsById", () => {
  it("keys the matcher's refusals so a row can say it never fires", () => {
    const map = rejectionsById([{ ruleId: "a", pattern: "??", reason: "Not a hostname" }]);
    expect(map.get("a")?.reason).toBe("Not a hostname");
    expect(map.get("b")).toBeUndefined();
  });
});

describe("personLabel", () => {
  const people = [
    { id: "p1", full_name: "Ada Lovelace", email: "ada@acme.test" },
    { id: "p2", full_name: "", email: "grace@acme.test" },
  ] as EmployeeRow[];

  it("prefers a name and falls back to the email", () => {
    expect(personLabel("p1", people)).toBe("Ada Lovelace");
    expect(personLabel("p2", people)).toBe("grace@acme.test");
  });

  it("returns null rather than printing a UUID", () => {
    expect(personLabel("p9", people)).toBeNull();
    expect(personLabel(null, people)).toBeNull();
  });
});
