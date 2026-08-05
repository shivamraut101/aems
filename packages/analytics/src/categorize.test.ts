import { describe, expect, it } from "vitest";

import {
  UNCATEGORIZED,
  UNCATEGORIZED_RESULT,
  categorizeActivityRow,
  categorizeEvent,
  compileRules,
  formatCategoryPath,
  matchesDomainPattern,
  parseCategoryPath,
  type CategoryRule,
} from "./categorize.js";

function rule(over: Partial<CategoryRule> & { id: string }): CategoryRule {
  return { path: ["Work"], productivity: "productive", priority: 100, ...over };
}

describe("compileRules — evaluation order", () => {
  it("takes the first match by ascending priority, not the last", () => {
    const set = compileRules([
      rule({ id: "late", priority: 90, path: ["Late"], matchApp: "Code" }),
      rule({ id: "early", priority: 10, path: ["Early"], matchApp: "Code" }),
    ]);

    const result = categorizeEvent(set, { appName: "Visual Studio Code" });

    expect(result.ruleId).toBe("early");
    expect(result.category).toBe("Early");
  });

  it("breaks a priority tie on the deeper path, then on id", () => {
    const set = compileRules([
      rule({ id: "b-shallow", priority: 50, path: ["Work"], matchApp: "Code" }),
      rule({ id: "a-deep", priority: 50, path: ["Work", "Development"], matchApp: "Code" }),
      rule({ id: "a-shallow", priority: 50, path: ["Other"], matchApp: "Code" }),
    ]);

    expect(categorizeEvent(set, { appName: "Code" }).ruleId).toBe("a-deep");

    const tie = compileRules([
      rule({ id: "b", priority: 50, path: ["B"], matchApp: "Code" }),
      rule({ id: "a", priority: 50, path: ["A"], matchApp: "Code" }),
    ]);
    expect(categorizeEvent(tie, { appName: "Code" }).ruleId).toBe("a");
  });

  it("does not mutate the caller's rule array", () => {
    const rules = [
      rule({ id: "second", priority: 90, matchApp: "Code" }),
      rule({ id: "first", priority: 10, matchApp: "Code" }),
    ];
    compileRules(rules);
    expect(rules.map((r) => r.id)).toEqual(["second", "first"]);
  });
});

describe("categorizeEvent — per-field matching, ANDed", () => {
  it("requires every declared field to match", () => {
    const set = compileRules([
      rule({ id: "review", path: ["Work", "Review"], matchApp: "Chrome", matchTitle: "Pull request" }),
    ]);

    expect(categorizeEvent(set, { appName: "Chrome", windowTitle: "Pull request #12" }).ruleId).toBe("review");
    // App matches, title does not — a rule that fired here would be the exact false
    // positive that per-field matching exists to prevent.
    expect(categorizeEvent(set, { appName: "Chrome", windowTitle: "Weather" }).ruleId).toBeNull();
    expect(categorizeEvent(set, { appName: "Slack", windowTitle: "Pull request #12" }).ruleId).toBeNull();
  });

  it("never matches a domain rule against an event that carries no domain", () => {
    const set = compileRules([rule({ id: "gh", path: ["Work", "Development"], matchDomain: "github.com" })]);

    expect(categorizeEvent(set, { appName: "Chrome", domain: "github.com" }).ruleId).toBe("gh");
    expect(categorizeEvent(set, { appName: "Chrome", domain: null }).ruleId).toBeNull();
    expect(categorizeEvent(set, { appName: "Chrome", domain: "" }).ruleId).toBeNull();
  });

  it("falls through a rule that matches nothing to the next one that does", () => {
    const set = compileRules([
      rule({ id: "never", priority: 10, path: ["Never"], matchApp: "ThisAppDoesNotExist" }),
      rule({ id: "hit", priority: 20, path: ["Hit"], matchApp: "Slack" }),
    ]);

    expect(categorizeEvent(set, { appName: "Slack" }).ruleId).toBe("hit");
  });
});

describe("categorizeEvent — domain suffix matching", () => {
  it("matches the host itself and any subdomain of it", () => {
    const set = compileRules([rule({ id: "gh", path: ["Work", "Development"], matchDomain: "example.com" })]);

    for (const host of ["example.com", "app.example.com", "a.b.example.com"]) {
      expect(categorizeEvent(set, { appName: "Chrome", domain: host }).ruleId).toBe("gh");
    }
  });

  it("refuses a host that merely ends with the pattern's characters", () => {
    const set = compileRules([rule({ id: "gh", path: ["Work"], matchDomain: "example.com" })]);

    // The suffix trap: string-suffix matching without the dot boundary hands an
    // attacker-registrable lookalike the same category as the real site.
    for (const host of ["notexample.com", "myexample.com", "example.com.evil.net", "example.company"]) {
      expect(categorizeEvent(set, { appName: "Chrome", domain: host }).ruleId).toBeNull();
    }
  });

  it("normalises host case, a trailing root dot and a port before comparing", () => {
    const set = compileRules([rule({ id: "gh", path: ["Work"], matchDomain: "Example.COM" })]);

    for (const host of ["EXAMPLE.com", "example.com.", "App.Example.com:8443"]) {
      expect(categorizeEvent(set, { appName: "Chrome", domain: host }).ruleId).toBe("gh");
    }
  });

  it("exposes the same suffix rule as a standalone predicate", () => {
    expect(matchesDomainPattern("example.com", "app.example.com", true)).toBe(true);
    expect(matchesDomainPattern("example.com", "notexample.com", true)).toBe(false);
    expect(matchesDomainPattern(".example.com", "example.com", true)).toBe(true);
  });

  it("treats a pattern with regex syntax as a regex rather than a literal suffix", () => {
    const set = compileRules([
      rule({ id: "social", path: ["Personal", "Social"], matchDomain: "(^|\\.)(?:facebook|instagram)\\.com$" }),
    ]);

    expect(categorizeEvent(set, { appName: "Chrome", domain: "www.facebook.com" }).ruleId).toBe("social");
    expect(categorizeEvent(set, { appName: "Chrome", domain: "notfacebook.com" }).ruleId).toBeNull();
  });
});

describe("categorizeEvent — case sensitivity", () => {
  it("ignores case by default", () => {
    const set = compileRules([rule({ id: "c", path: ["Work"], matchApp: "chrome" })]);
    expect(categorizeEvent(set, { appName: "Google Chrome" }).ruleId).toBe("c");
  });

  it("honours ignoreCase: false on app and title patterns", () => {
    const set = compileRules([rule({ id: "c", path: ["Work"], matchApp: "chrome", ignoreCase: false })]);
    expect(categorizeEvent(set, { appName: "Google Chrome" }).ruleId).toBeNull();
    expect(categorizeEvent(set, { appName: "google chrome" }).ruleId).toBe("c");
  });

  it("keeps literal domain matching case-insensitive even when ignoreCase is false", () => {
    // Hostnames are case-insensitive by DNS definition, so an admin unticking
    // "ignore case" for a title pattern must not silently break their domain rules.
    const set = compileRules([rule({ id: "d", path: ["Work"], matchDomain: "Example.com", ignoreCase: false })]);
    expect(categorizeEvent(set, { appName: "Chrome", domain: "APP.EXAMPLE.COM" }).ruleId).toBe("d");
  });
});

describe("categorizeEvent — fallback", () => {
  it("returns Uncategorized/neutral for an empty rule set", () => {
    const set = compileRules([]);
    const result = categorizeEvent(set, { appName: "Anything", windowTitle: "x", domain: "y.com" });

    expect(result).toEqual(UNCATEGORIZED_RESULT);
    expect(result.category).toBe(UNCATEGORIZED);
    expect(result.productivity).toBe("neutral");
    expect(result.ruleId).toBeNull();
  });

  it("never labels an unknown application unproductive", () => {
    const set = compileRules([rule({ id: "x", path: ["Work"], productivity: "unproductive", matchApp: "Solitaire" })]);
    expect(categorizeEvent(set, { appName: "SomeInternalTool" }).productivity).toBe("neutral");
  });

  it("carries the rule's tri-state productivity through", () => {
    const set = compileRules([
      rule({ id: "p", priority: 10, path: ["Work", "Development"], productivity: "productive", matchApp: "^Code$" }),
      rule({ id: "n", priority: 20, path: ["System"], productivity: "neutral", matchApp: "^Finder$" }),
      rule({ id: "u", priority: 30, path: ["Personal"], productivity: "unproductive", matchApp: "^Steam$" }),
    ]);

    expect(categorizeEvent(set, { appName: "Code" }).productivity).toBe("productive");
    expect(categorizeEvent(set, { appName: "Finder" }).productivity).toBe("neutral");
    expect(categorizeEvent(set, { appName: "Steam" }).productivity).toBe("unproductive");
  });
});

describe("compileRules — rejecting rules instead of trusting them", () => {
  it("rejects a rule with no match field at all", () => {
    const set = compileRules([rule({ id: "empty", path: ["Work"] })]);

    expect(set.rules).toHaveLength(0);
    expect(set.rejected).toEqual([expect.objectContaining({ ruleId: "empty", field: "rule" })]);
    expect(categorizeEvent(set, { appName: "Anything" }).category).toBe(UNCATEGORIZED);
  });

  it("rejects a rule with invalid regex syntax and keeps the rest working", () => {
    const set = compileRules([
      rule({ id: "broken", priority: 10, path: ["Broken"], matchApp: "([unclosed" }),
      rule({ id: "fine", priority: 20, path: ["Fine"], matchApp: "Slack" }),
    ]);

    expect(set.rejected).toEqual([expect.objectContaining({ ruleId: "broken", field: "app" })]);
    expect(categorizeEvent(set, { appName: "Slack" }).ruleId).toBe("fine");
  });

  it("rejects the whole rule when one of its fields is unusable", () => {
    // Dropping just the bad field would widen the rule — an app+title rule would
    // silently become an app-only rule and match far more than it was written to.
    const set = compileRules([
      rule({ id: "half", path: ["Half"], matchApp: "Chrome", matchTitle: "([unclosed" }),
    ]);

    expect(set.rules).toHaveLength(0);
    expect(categorizeEvent(set, { appName: "Chrome", windowTitle: "anything" }).category).toBe(UNCATEGORIZED);
  });

  it("rejects a pattern that could backtrack catastrophically, and stays fast", () => {
    const set = compileRules([
      rule({ id: "evil", priority: 10, path: ["Evil"], matchTitle: "(a+)+$" }),
      rule({ id: "good", priority: 20, path: ["Good"], matchApp: "Chrome" }),
    ]);

    expect(set.rejected).toEqual([expect.objectContaining({ ruleId: "evil", field: "title" })]);

    // Unguarded, `(a+)+$` against 42 a's then a b is ~2^42 backtracks — minutes to
    // hours. This assertion is the guard's actual point, not the rejection list.
    const subject = `${"a".repeat(42)}b`;
    const started = Date.now();
    const result = categorizeEvent(set, { appName: "Chrome", windowTitle: subject });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.ruleId).toBe("good");
  });

  it("rejects an unbounded nested repetition written with braces", () => {
    const set = compileRules([rule({ id: "braces", path: ["X"], matchTitle: "([a-z]{2,}){3,}" })]);
    expect(set.rules).toHaveLength(0);
  });

  it("keeps a plain alternation that is not repeated", () => {
    const set = compileRules([rule({ id: "ok", path: ["Work"], matchApp: "^(?:Code|IntelliJ|WebStorm)" })]);

    expect(set.rejected).toEqual([]);
    expect(categorizeEvent(set, { appName: "IntelliJ IDEA" }).ruleId).toBe("ok");
  });

  it("bounds the subject it feeds a regex", () => {
    const set = compileRules([rule({ id: "t", path: ["Work"], matchTitle: "needle" })]);

    const started = Date.now();
    const far = `${"x".repeat(200_000)}needle`;
    // Past the cap the needle is not there to be found — a bounded, wrong-but-cheap
    // answer beats an unbounded scan over data an agent should never have sent.
    expect(categorizeEvent(set, { appName: "Chrome", windowTitle: far }).ruleId).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("read-time recategorisation", () => {
  it("reads a database row's snake_case columns", () => {
    const set = compileRules([rule({ id: "gh", path: ["Work", "Development"], matchDomain: "github.com" })]);

    const result = categorizeActivityRow(set, {
      app_name: "Google Chrome",
      window_title: "aems · PRs",
      domain: "gist.github.com",
    });

    expect(result.category).toBe("Work > Development");
    expect(result.ruleId).toBe("gh");
  });

  it("relabels the same event when the rules change, with no stored value involved", () => {
    const row = { app_name: "Figma", window_title: "Dashboard", domain: null };

    const before = compileRules([rule({ id: "dev", path: ["Work", "Development"], matchApp: "Code" })]);
    expect(categorizeActivityRow(before, row).category).toBe(UNCATEGORIZED);

    const after = compileRules([
      rule({ id: "dev", priority: 10, path: ["Work", "Development"], matchApp: "Code" }),
      rule({ id: "design", priority: 20, path: ["Work", "Design"], matchApp: "Figma" }),
    ]);
    expect(categorizeActivityRow(after, row).category).toBe("Work > Design");
  });
});

describe("category path formatting", () => {
  it("joins and splits on the same separator", () => {
    expect(formatCategoryPath(["Work", "Development"])).toBe("Work > Development");
    expect(parseCategoryPath("Work > Development")).toEqual(["Work", "Development"]);
  });

  it("round-trips the fallback", () => {
    expect(parseCategoryPath(formatCategoryPath([UNCATEGORIZED]))).toEqual([UNCATEGORIZED]);
  });

  it("treats an empty or unparseable label as Uncategorized", () => {
    expect(parseCategoryPath(null)).toEqual([UNCATEGORIZED]);
    expect(parseCategoryPath("   ")).toEqual([UNCATEGORIZED]);
  });
});
