import { describe, expect, it } from "vitest";

import type { PageState } from "./pages.js";
import {
  blockedFooter,
  blockedHeadline,
  blockedReason,
  blockedRows,
  popupRows,
  ruleIdFrom,
} from "./pages.js";

function page(patch: Partial<PageState> = {}): PageState {
  return {
    monitoring: "collecting",
    policy: { version: "2026.08.01", name: "Standard monitoring policy" },
    contact: "it-support@acme.test",
    restrictedCount: 2,
    rule: null,
    websites: true,
    ...patch,
  };
}

describe("popupRows", () => {
  it("names the policy, its version and how many sites are restricted", () => {
    expect(popupRows(page())).toEqual([
      { label: "Policy", value: "Standard monitoring policy" },
      { label: "Version", value: "2026.08.01" },
      { label: "Restricted sites", value: "2" },
      { label: "Questions", value: "it-support@acme.test" },
    ]);
  });

  it("says None rather than 0, which reads as a broken counter", () => {
    expect(popupRows(page({ restrictedCount: 0 }))).toContainEqual({
      label: "Restricted sites",
      value: "None",
    });
  });

  it("omits what it does not know instead of printing an empty row", () => {
    expect(popupRows(page({ policy: null, contact: null }))).toEqual([
      { label: "Restricted sites", value: "2" },
    ]);
  });
});

describe("blockedRows", () => {
  it("always names the policy and someone to ask", () => {
    // The scope decision that put website restriction in the MVP requires exactly this:
    // an employee must be able to see which policy blocked a page and who to ask.
    expect(blockedRows(page())).toEqual([
      { label: "Policy", value: "Standard monitoring policy (2026.08.01)" },
      { label: "Ask", value: "it-support@acme.test" },
    ]);
  });

  it("falls back to a person rather than leaving the question unanswered", () => {
    expect(blockedRows(page({ contact: null }))).toContainEqual({
      label: "Ask",
      value: "Your IT administrator or your manager",
    });
  });

  it("says the agent is unreachable rather than showing an empty policy", () => {
    expect(blockedRows(page({ policy: null }))).toContainEqual({
      label: "Policy",
      value: "Not available — the AEMS agent is not reachable",
    });
  });
});

describe("blockedFooter", () => {
  it("says addresses are reported while they actually are", () => {
    const foot = blockedFooter(page());

    expect(foot).toContain("reported to the AEMS agent");
    expect(foot).toContain("the person named above can change it");
  });

  /**
   * The reason this is a function and not a line of markup. `mayEnforce` is deliberately
   * wider than `mayReport`, so this page is reachable by design in front of someone who
   * has not accepted the monitoring policy — and telling that person their browsing is
   * already reported is the reading that makes the consent screen look like theatre.
   */
  it("does not claim reporting in a state where nothing is reported", () => {
    for (const monitoring of ["consent-required", "not-enrolled", "revoked", null]) {
      const foot = blockedFooter(page({ monitoring }));

      expect(foot).toContain("Nothing you open in this browser is being recorded");
      expect(foot).not.toContain("reported to the AEMS agent");
    }
  });

  it("names the switched-off scope rather than claiming a recording that is off", () => {
    const foot = blockedFooter(page({ websites: false }));

    expect(foot).toContain("your organisation has switched that off");
    expect(foot).not.toContain("reported to the AEMS agent");
  });

  /** The default in blocked.html is the unreachable-agent branch, so it must be true. */
  it("keeps the restriction attributable in every state", () => {
    for (const state of [page(), page({ monitoring: null }), page({ websites: false })]) {
      expect(blockedFooter(state)).toContain("device policy named above");
    }
  });
});

describe("blockedHeadline", () => {
  it("names the restricted domain when the rule is known", () => {
    expect(blockedHeadline({ id: 1, domain: "example.com", reason: null })).toBe(
      "example.com is restricted on this device",
    );
  });

  it("still explains itself when the rule could not be resolved", () => {
    expect(blockedHeadline(null)).toBe("This site is restricted on this device");
  });
});

describe("blockedReason", () => {
  it("prefers the administrator's own words", () => {
    expect(blockedReason({ id: 1, domain: "a.test", reason: "  Not work related  " })).toBe(
      "Not work related",
    );
  });

  it("shows nothing rather than an empty quote", () => {
    expect(blockedReason({ id: 1, domain: "a.test", reason: "   " })).toBeNull();
    expect(blockedReason({ id: 1, domain: "a.test", reason: null })).toBeNull();
    expect(blockedReason(null)).toBeNull();
  });
});

describe("ruleIdFrom", () => {
  it("reads the id the redirect put in the query", () => {
    expect(ruleIdFrom("?rule=42")).toBe(42);
  });

  it("treats anything that is not a positive integer as absent", () => {
    expect(ruleIdFrom("?rule=0")).toBeUndefined();
    expect(ruleIdFrom("?rule=-1")).toBeUndefined();
    expect(ruleIdFrom("?rule=abc")).toBeUndefined();
    expect(ruleIdFrom("?rule=1.5")).toBeUndefined();
    expect(ruleIdFrom("")).toBeUndefined();
  });
});
