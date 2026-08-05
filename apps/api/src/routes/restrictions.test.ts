import type { SessionProfile } from "@aems/auth";
import type { AemsSupabaseClient } from "@aems/supabase";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import type { DeviceContext } from "../plugins/context.js";

import {
  MAX_RULES_PER_COMPANY,
  canonicalDomainPattern,
  compileRestrictionRules,
  compileUrlPattern,
  evaluateUrl,
  hostMatchesDomain,
  normalizeDomainPattern,
  parseTargetUrl,
  restrictionRoutes,
  storedPatternFor,
  type RestrictionRule,
  type RestrictionSettings,
} from "./restrictions.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const BOB = "22222222-2222-4222-8222-222222222222";
const ALICE = "11111111-1111-4111-8111-111111111111";
const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RULE_A = "aa000000-0000-4000-8000-000000000001";
const RULE_B = "bb000000-0000-4000-8000-000000000002";

const admin: SessionProfile = { profileId: ADMIN, companyId: COMPANY, email: "a@x", role: "super_admin" };
const manager: SessionProfile = { profileId: BOB, companyId: COMPANY, email: "m@x", role: "manager" };
const alice: SessionProfile = { profileId: ALICE, companyId: COMPANY, email: "e@x", role: "employee" };

const device: DeviceContext = { deviceId: DEVICE, companyId: COMPANY, profileId: ALICE };

// ===========================================================================
// The matcher
//
// This is the feature. Everything below the fold is plumbing around it.
// ===========================================================================

/** Shorthand: one rule, enabled, priority 100. */
function rule(partial: Partial<RestrictionRule> & Pick<RestrictionRule, "pattern">): RestrictionRule {
  return {
    id: partial.id ?? "r1",
    action: partial.action ?? "block",
    matchKind: partial.matchKind ?? "domain",
    pattern: partial.pattern,
    priority: partial.priority ?? 100,
    enabled: partial.enabled ?? true,
  };
}

const BLOCKLIST: RestrictionSettings = { enabled: true, mode: "blocklist" };
const ALLOWLIST: RestrictionSettings = { enabled: true, mode: "allowlist" };

/** Does this single rule claim this URL? */
function claims(r: RestrictionRule, url: string): boolean {
  const set = compileRestrictionRules([r]);
  const decision = evaluateUrl(url, set, BLOCKLIST);
  return decision.reason === "rule";
}

describe("parseTargetUrl", () => {
  it("reads the parts a rule compares", () => {
    const parsed = parseTargetUrl("https://App.Example.COM:8443/Docs/Index.html?q=1#frag");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.target).toMatchObject({
      scheme: "https",
      host: "app.example.com",
      port: "8443",
      path: "/docs/index.html",
      query: "q=1",
    });
    // The fragment never leaves the browser and is not part of a request.
    expect(parsed.target.canonical).toBe("https://app.example.com:8443/Docs/Index.html");
  });

  it("fills in the default port so a rule can pin :443", () => {
    const https = parseTargetUrl("https://example.com/");
    const http = parseTargetUrl("http://example.com/");
    expect(https.ok && https.target.port).toBe("443");
    expect(http.ok && http.target.port).toBe("80");
  });

  it("keeps the original case in the stored form and lower-cases only the matching form", () => {
    // Lower-casing a case-sensitive path in the audit record would be a record of
    // something that did not happen.
    const parsed = parseTargetUrl("https://example.com/CaseSensitive/Path");
    expect(parsed.ok && parsed.target.canonical).toBe("https://example.com/CaseSensitive/Path");
    expect(parsed.ok && parsed.target.path).toBe("/casesensitive/path");
  });

  it("drops the query string from the stored form", () => {
    // A query carries session tokens, search terms and one-time links. Retaining them
    // would turn an enforcement log into a credential store.
    const parsed = parseTargetUrl("https://example.com/reset?token=SECRET&user=alice");
    expect(parsed.ok && parsed.target.canonical).toBe("https://example.com/reset");
    expect(parsed.ok && parsed.target.canonical).not.toContain("SECRET");
    // …while still being matchable.
    expect(parsed.ok && parsed.target.query).toBe("token=secret&user=alice");
  });

  it("assumes https for a string with no scheme, which is what a Windows agent has", () => {
    const parsed = parseTargetUrl("example.com/pricing");
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.target.host).toBe("example.com");
    expect(parsed.ok && parsed.target.scheme).toBe("https");
  });

  it("reads host:port as a host and a port, not as a scheme", () => {
    const parsed = parseTargetUrl("localhost:3000/admin");
    expect(parsed.ok && parsed.target.host).toBe("localhost");
    expect(parsed.ok && parsed.target.port).toBe("3000");
  });

  it("refuses to restrict anything that is not http(s)", () => {
    // An allow-list that blocked chrome://newtab, about:blank or the extension's own
    // block page would brick the browser — and the page explaining the block is one of
    // those pages.
    for (const url of [
      "chrome://settings",
      "about:blank",
      "file:///C:/Users/alice/report.pdf",
      "mailto:alice@example.com",
      "data:text/html,<h1>hi</h1>",
      "javascript:alert(1)",
      "ftp://files.example.com/x",
      "edge://extensions",
    ]) {
      expect(parseTargetUrl(url), url).toMatchObject({ ok: false, reason: "scheme_not_restricted" });
    }
  });

  it("reports garbage as unparsable rather than pretending", () => {
    for (const value of ["", "   ", "http://", "https://", "//", "%%%", "\n"]) {
      expect(parseTargetUrl(value), JSON.stringify(value)).toMatchObject({ ok: false });
    }
    expect(parseTargetUrl(null)).toMatchObject({ ok: false, reason: "unparsable_url" });
    expect(parseTargetUrl(12)).toMatchObject({ ok: false, reason: "unparsable_url" });
  });

  it("refuses a URL long enough to be an attack rather than a visit", () => {
    expect(parseTargetUrl(`https://example.com/${"a".repeat(5000)}`)).toMatchObject({
      ok: false,
      reason: "unparsable_url",
    });
  });

  it("normalises an IDN host to punycode, which is what the browser requests", () => {
    const unicode = parseTargetUrl("https://münchen.de/");
    const punycode = parseTargetUrl("https://xn--mnchen-3ya.de/");
    expect(unicode.ok && unicode.target.host).toBe("xn--mnchen-3ya.de");
    expect(punycode.ok && punycode.target.host).toBe("xn--mnchen-3ya.de");
  });

  it("strips the root dot of a fully-qualified name", () => {
    const parsed = parseTargetUrl("https://example.com./x");
    expect(parsed.ok && parsed.target.host).toBe("example.com");
  });

  it("reads the host past any credentials, so evil.com@example.com is example.com", () => {
    const parsed = parseTargetUrl("https://evil.com@example.com/");
    expect(parsed.ok && parsed.target.host).toBe("example.com");
    // …and the mirror image, which a substring matcher gets wrong in the other
    // direction: this one really is evil.com.
    const other = parseTargetUrl("https://example.com@evil.com/");
    expect(other.ok && other.target.host).toBe("evil.com");
  });

  it("normalises the decimal and hex spellings of an IPv4 address", () => {
    expect(parseTargetUrl("http://2130706433/").ok && parseTargetUrl("http://2130706433/")).toMatchObject(
      { target: { host: "127.0.0.1" } },
    );
    expect(parseTargetUrl("http://0x7f.0.0.1/")).toMatchObject({ target: { host: "127.0.0.1" } });
  });

  it("keeps an IPv6 literal in its brackets", () => {
    const parsed = parseTargetUrl("http://[::1]:8080/x");
    expect(parsed.ok && parsed.target.host).toBe("[::1]");
    expect(parsed.ok && parsed.target.port).toBe("8080");
  });

  it("decodes percent-encoding once, so /%61dmin is not a bypass", () => {
    const parsed = parseTargetUrl("https://example.com/%61dmin");
    expect(parsed.ok && parsed.target.path).toBe("/admin");
  });

  it("decodes exactly once, so %2525 does not keep unwrapping", () => {
    const parsed = parseTargetUrl("https://example.com/%2525");
    expect(parsed.ok && parsed.target.path).toBe("/%25");
  });

  it("survives a malformed escape instead of throwing", () => {
    const parsed = parseTargetUrl("https://example.com/100%off");
    expect(parsed.ok).toBe(true);
  });
});

describe("hostMatchesDomain", () => {
  it("claims the host itself and every subdomain", () => {
    for (const host of ["example.com", "www.example.com", "a.b.c.example.com"]) {
      expect(hostMatchesDomain("example.com", host), host).toBe(true);
    }
  });

  it("NEVER claims notexample.com", () => {
    // The headline case. A plain endsWith gets this wrong, and the difference is a
    // lookalike domain inheriting a real site's permission.
    for (const host of ["notexample.com", "myexample.com", "xexample.com"]) {
      expect(hostMatchesDomain("example.com", host), host).toBe(false);
    }
  });

  it("is not fooled by a suffix that only looks like one", () => {
    expect(hostMatchesDomain("example.com", "example.com.evil.com")).toBe(false);
    expect(hostMatchesDomain("example.com", "example.community")).toBe(false);
    expect(hostMatchesDomain("example.com", "example.co")).toBe(false);
  });

  it("ignores case on both sides", () => {
    expect(hostMatchesDomain("Example.COM", "WWW.example.com")).toBe(true);
  });

  it("ignores a trailing root dot on either side", () => {
    expect(hostMatchesDomain("example.com.", "www.example.com")).toBe(true);
    expect(hostMatchesDomain("example.com", "www.example.com.")).toBe(true);
  });

  it("accepts the three ways admins habitually write a domain", () => {
    for (const pattern of ["example.com", ".example.com", "*.example.com"]) {
      expect(hostMatchesDomain(pattern, "app.example.com"), pattern).toBe(true);
      // The wildcard form still covers the apex; nobody means to exclude it.
      expect(hostMatchesDomain(pattern, "example.com"), pattern).toBe(true);
    }
  });

  it("accepts a pasted URL, because that is what people paste", () => {
    for (const pattern of [
      "https://example.com",
      "https://example.com/pricing?ref=x",
      "http://example.com:8080/",
      "example.com:8080",
      "https://user:pw@example.com/",
    ]) {
      expect(hostMatchesDomain(pattern, "app.example.com"), pattern).toBe(true);
    }
  });

  it("matches an IDN pattern against the punycode host the browser actually requests", () => {
    expect(hostMatchesDomain("münchen.de", "xn--mnchen-3ya.de")).toBe(true);
    expect(hostMatchesDomain("münchen.de", "www.xn--mnchen-3ya.de")).toBe(true);
    expect(hostMatchesDomain("xn--mnchen-3ya.de", "xn--mnchen-3ya.de")).toBe(true);
    expect(hostMatchesDomain("münchen.de", "muenchen.de")).toBe(false);
  });

  it("matches an IP address exactly and never as a suffix", () => {
    // Labels are not hierarchical rightwards in an address: suffix logic would let a
    // rule for "1.1" claim 192.168.1.1.
    expect(hostMatchesDomain("192.168.1.1", "192.168.1.1")).toBe(true);
    expect(hostMatchesDomain("1.1", "192.168.1.1")).toBe(false);
    expect(hostMatchesDomain("168.1.1", "192.168.1.1")).toBe(false);
    expect(hostMatchesDomain("[::1]", "[::1]")).toBe(true);
    expect(hostMatchesDomain("::1", "[::1]")).toBe(false);
  });

  it("refuses a pattern that is not a hostname rather than matching everything", () => {
    for (const pattern of ["", "   ", "*", "*.*", "ex ample.com", "/", "http://"]) {
      expect(hostMatchesDomain(pattern, "example.com"), JSON.stringify(pattern)).toBe(false);
    }
  });

  it("refuses an empty host rather than matching everything", () => {
    expect(hostMatchesDomain("example.com", "")).toBe(false);
  });

  it("ignores port, path and query entirely — a domain rule is about the host", () => {
    const r = rule({ pattern: "example.com", matchKind: "domain" });
    for (const url of [
      "https://example.com",
      "http://example.com:8080/deep/path?x=1",
      "https://sub.example.com/?q=a#frag",
    ]) {
      expect(claims(r, url), url).toBe(true);
    }
  });
});

describe("canonicalDomainPattern / normalizeDomainPattern", () => {
  it("strips the structure around a host but leaves the spelling alone", () => {
    expect(canonicalDomainPattern("https://User:pw@WWW.Example.com:8443/pricing?ref=x")).toBe(
      "www.example.com",
    );
    expect(canonicalDomainPattern("*.example.com")).toBe("example.com");
    expect(canonicalDomainPattern(".example.com.")).toBe("example.com");
  });

  it("keeps an admin's unicode spelling and lets the matcher do the punycode", () => {
    // `xn--mnchen-3ya.de` on a settings screen is a rule nobody can read back.
    expect(canonicalDomainPattern("münchen.de")).toBe("münchen.de");
    expect(normalizeDomainPattern("münchen.de")).toBe("xn--mnchen-3ya.de");
  });

  it("rejects the same non-hosts in both forms", () => {
    for (const value of ["", "  ", "*", "*/internal*", "ex ample.com", "example.com:notaport"]) {
      expect(canonicalDomainPattern(value), value).toBeNull();
      expect(normalizeDomainPattern(value), value).toBeNull();
    }
  });

  // The WHATWG URL parser is not a hostname validator: it only refuses the "forbidden
  // host code points", so it hands back `!!!bad!!!`, `-lead.com` and `a..b` as hosts.
  // A rule built on one compiles cleanly and then matches nothing for ever, which in
  // allow-list mode is an admin believing a site is reachable when it is not. Refused
  // at the write instead.
  it("refuses a typo the URL parser is happy to accept as a host", () => {
    for (const value of ["!!!bad!!!", "-lead.com", "trail-.com", "a..b", "..", "-", "a!b.com", "%%%"]) {
      expect(normalizeDomainPattern(value), value).toBeNull();
      expect(storedPatternFor("domain", value), value).toBeNull();
    }
  });

  // The tightening must not cost a real network anything: single-label internal names
  // and underscored internal DNS are legitimate and stay legitimate.
  it("still accepts every host a real corporate network uses", () => {
    for (const value of [
      "example.com",
      "a.b.c.d.example.com",
      "localhost",
      "intranet",
      "my_host.corp",
      "internal_api.corp.local",
      "192.168.1.1",
      "xn--mnchen-3ya.de",
      "münchen.de",
      "host-with-hyphens.example.com",
      "3com.com",
      "a",
    ]) {
      expect(normalizeDomainPattern(value), value).not.toBeNull();
    }
  });
});

describe("storedPatternFor", () => {
  it("is the single answer to both 'is this usable' and 'what gets written'", () => {
    // A pattern the API accepted and the matcher then skipped is a rule an admin
    // believes is in force and is not, so one function decides both.
    expect(storedPatternFor("domain", "https://example.com/x")).toBe("example.com");
    expect(storedPatternFor("domain", "*/internal*")).toBeNull();
    expect(storedPatternFor("url_pattern", "  example.com/Admin/*  ")).toBe("example.com/Admin/*");
    expect(storedPatternFor("url_pattern", "/")).toBeNull();
  });
});

describe("compileUrlPattern", () => {
  it("refuses a pattern it cannot make sense of", () => {
    for (const pattern of ["", "   ", "/", "//x", ":8080", `a${"b".repeat(500)}.com`]) {
      expect(compileUrlPattern(pattern), JSON.stringify(pattern)).toBeNull();
    }
  });

  it("refuses a pattern with more wildcards than any real rule needs", () => {
    expect(compileUrlPattern(`example.com/${"*/".repeat(12)}`)).toBeNull();
  });
});

describe("url_pattern matching", () => {
  const pattern = (p: string, over: Partial<RestrictionRule> = {}) =>
    rule({ ...over, pattern: p, matchKind: "url_pattern" });

  it("treats a bare host as host-or-subdomain, the same as a domain rule", () => {
    const r = pattern("example.com");
    expect(claims(r, "https://example.com/")).toBe(true);
    expect(claims(r, "https://www.example.com/anything")).toBe(true);
    expect(claims(r, "https://notexample.com/")).toBe(false);
  });

  it("matches http and https when no scheme is written, and only the named one when it is", () => {
    expect(claims(pattern("example.com"), "http://example.com/")).toBe(true);
    expect(claims(pattern("example.com"), "https://example.com/")).toBe(true);

    expect(claims(pattern("https://example.com"), "https://example.com/")).toBe(true);
    expect(claims(pattern("https://example.com"), "http://example.com/")).toBe(false);

    expect(claims(pattern("*://example.com"), "http://example.com/")).toBe(true);
  });

  it("pins a port when one is written and ignores it when one is not", () => {
    expect(claims(pattern("localhost:3000"), "http://localhost:3000/app")).toBe(true);
    expect(claims(pattern("localhost:3000"), "http://localhost:4000/app")).toBe(false);
    expect(claims(pattern("localhost"), "http://localhost:4000/app")).toBe(true);
    // Defaults are filled in, so pinning :443 works on an ordinary https URL.
    expect(claims(pattern("example.com:443"), "https://example.com/")).toBe(true);
    expect(claims(pattern("example.com:80"), "https://example.com/")).toBe(false);
    expect(claims(pattern("example.com:*"), "https://example.com:9999/")).toBe(true);
  });

  it("matches a wildcard-less path at a segment boundary, never mid-word", () => {
    const r = pattern("example.com/admin");
    for (const url of [
      "https://example.com/admin",
      "https://example.com/admin/",
      "https://example.com/admin/users",
      "https://example.com/admin?tab=1",
    ]) {
      expect(claims(r, url), url).toBe(true);
    }
    // The path-shaped twin of notexample.com.
    for (const url of ["https://example.com/administrator", "https://example.com/adminx", "https://example.com/"]) {
      expect(claims(r, url), url).toBe(false);
    }
  });

  it("globs when a wildcard is written", () => {
    expect(claims(pattern("example.com/files/*.pdf"), "https://example.com/files/q3/report.pdf")).toBe(true);
    expect(claims(pattern("example.com/files/*.pdf"), "https://example.com/files/report.docx")).toBe(false);
    expect(claims(pattern("example.com/*"), "https://example.com/anything/at/all")).toBe(true);
  });

  it("matches against the query string when the pattern reaches into it", () => {
    expect(claims(pattern("example.com/search*q=secret*"), "https://example.com/search?q=secret&p=2")).toBe(
      true,
    );
    expect(claims(pattern("example.com/search*q=secret*"), "https://example.com/search?q=public")).toBe(false);
  });

  it("treats ? as a literal, not as a single-character wildcard", () => {
    // `?` is a URL delimiter. An admin who typed /search?q=x must get a literal.
    expect(claims(pattern("example.com/search?q=x"), "https://example.com/search?q=x")).toBe(true);
    expect(claims(pattern("example.com/search?q=x"), "https://example.com/searchXq=x")).toBe(false);
  });

  it("does not let regex syntax in a pattern behave as regex", () => {
    expect(claims(pattern("example.com/a.c"), "https://example.com/abc")).toBe(false);
    expect(claims(pattern("example.com/a.c"), "https://example.com/a.c")).toBe(true);
    expect(claims(pattern("example.com/(a|b)"), "https://example.com/a")).toBe(false);
  });

  it("matches percent-encoded paths through the decoded form", () => {
    expect(claims(pattern("example.com/admin"), "https://example.com/%61dmin/users")).toBe(true);
  });

  it("supports a wildcard in the middle of a host", () => {
    expect(claims(pattern("ads-*.example.com/*"), "https://ads-eu.example.com/banner")).toBe(true);
    expect(claims(pattern("ads-*.example.com/*"), "https://cdn.example.com/banner")).toBe(false);
  });

  it("matches every host when the host is a bare wildcard", () => {
    const r = pattern("*/internal-tools*");
    expect(claims(r, "https://anything.test/internal-tools/x")).toBe(true);
    expect(claims(r, "https://anything.test/public")).toBe(false);
  });
});

describe("evaluateUrl", () => {
  const blockExample = rule({ id: RULE_A, pattern: "example.com", action: "block", priority: 10 });

  it("does nothing at all while the feature is switched off", () => {
    const set = compileRestrictionRules([blockExample]);
    expect(evaluateUrl("https://example.com/", set, { enabled: false, mode: "allowlist" })).toMatchObject({
      blocked: false,
      reason: "restrictions_disabled",
    });
  });

  it("permits an unmatched URL under a block-list and refuses it under an allow-list", () => {
    const set = compileRestrictionRules([blockExample]);
    expect(evaluateUrl("https://other.test/", set, BLOCKLIST)).toMatchObject({
      blocked: false,
      reason: "default",
      ruleId: null,
    });
    expect(evaluateUrl("https://other.test/", set, ALLOWLIST)).toMatchObject({
      blocked: true,
      reason: "default",
      ruleId: null,
    });
  });

  it("names the rule that decided, so a block page can explain itself", () => {
    const set = compileRestrictionRules([blockExample]);
    expect(evaluateUrl("https://app.example.com/x", set, BLOCKLIST)).toEqual({
      blocked: true,
      reason: "rule",
      ruleId: RULE_A,
      matchedPattern: "example.com",
      mode: "blocklist",
    });
  });

  it("stops at the first rule by priority, so an allow carve-out beats a broad block", () => {
    const set = compileRestrictionRules([
      rule({ id: RULE_A, pattern: "example.com", action: "block", priority: 50 }),
      rule({ id: RULE_B, pattern: "docs.example.com", action: "allow", priority: 10 }),
    ]);
    expect(evaluateUrl("https://docs.example.com/guide", set, BLOCKLIST)).toMatchObject({
      blocked: false,
      ruleId: RULE_B,
    });
    expect(evaluateUrl("https://mail.example.com/", set, BLOCKLIST)).toMatchObject({
      blocked: true,
      ruleId: RULE_A,
    });
  });

  it("carves the other way too: a block rule inside an allow-list", () => {
    const set = compileRestrictionRules([
      rule({ id: RULE_A, pattern: "example.com", action: "allow", priority: 50 }),
      rule({ id: RULE_B, pattern: "careers.example.com", action: "block", priority: 10 }),
    ]);
    expect(evaluateUrl("https://intranet.example.com/", set, ALLOWLIST)).toMatchObject({ blocked: false });
    expect(evaluateUrl("https://careers.example.com/", set, ALLOWLIST)).toMatchObject({ blocked: true });
    expect(evaluateUrl("https://elsewhere.test/", set, ALLOWLIST)).toMatchObject({
      blocked: true,
      reason: "default",
    });
  });

  it("breaks a priority tie by id so two servers always agree", () => {
    const set = compileRestrictionRules([
      rule({ id: RULE_B, pattern: "example.com", action: "block", priority: 10 }),
      rule({ id: RULE_A, pattern: "example.com", action: "allow", priority: 10 }),
    ]);
    expect(set.rules[0]!.id).toBe(RULE_A);
    expect(evaluateUrl("https://example.com/", set, BLOCKLIST)).toMatchObject({ ruleId: RULE_A });
  });

  it("never evaluates a rule an admin switched off", () => {
    const set = compileRestrictionRules([{ ...blockExample, enabled: false }]);
    expect(set.rules).toHaveLength(0);
    expect(evaluateUrl("https://example.com/", set, BLOCKLIST)).toMatchObject({ reason: "default" });
  });

  it("skips a rule it cannot compile and says which, instead of failing the whole set", () => {
    // One malformed pattern must not decide the fate of every page in the company.
    const set = compileRestrictionRules([
      rule({ id: RULE_A, pattern: "  ", matchKind: "domain" }),
      rule({ id: RULE_B, pattern: "example.com", action: "block", priority: 10 }),
    ]);
    expect(set.rules.map((r) => r.id)).toEqual([RULE_B]);
    expect(set.rejected).toHaveLength(1);
    expect(set.rejected[0]).toMatchObject({ ruleId: RULE_A });
    expect(evaluateUrl("https://example.com/", set, BLOCKLIST)).toMatchObject({ blocked: true });
  });

  it("rejects an over-long pattern with a reason rather than compiling it", () => {
    const set = compileRestrictionRules([rule({ id: RULE_A, pattern: "a".repeat(401) })]);
    expect(set.rules).toHaveLength(0);
    expect(set.rejected[0]?.reason).toMatch(/longer than/);
  });

  it("FAILS OPEN on a scheme it does not restrict, even under an allow-list", () => {
    // The single most important behaviour here. An allow-list that blocked
    // chrome://newtab, about:blank or the extension's own block page takes the browser
    // down with it — including the page that would explain the block.
    const set = compileRestrictionRules([]);
    for (const url of ["chrome://newtab", "about:blank", "file:///C:/x", "moz-extension://abc/block.html"]) {
      expect(evaluateUrl(url, set, ALLOWLIST), url).toMatchObject({
        blocked: false,
        reason: "scheme_not_restricted",
      });
    }
  });

  it("FAILS OPEN on a URL it cannot parse, even under an allow-list", () => {
    const set = compileRestrictionRules([]);
    expect(evaluateUrl("%%%", set, ALLOWLIST)).toMatchObject({
      blocked: false,
      reason: "unparsable_url",
    });
  });

  it("always reports the mode, so a block record can be read years later", () => {
    const set = compileRestrictionRules([blockExample]);
    expect(evaluateUrl("https://example.com/", set, ALLOWLIST).mode).toBe("allowlist");
    expect(evaluateUrl("https://nothing.test/", set, BLOCKLIST).mode).toBe("blocklist");
  });

  it("holds up against a realistic company rule set", () => {
    const set = compileRestrictionRules([
      rule({ id: "r-social", pattern: "facebook.com", action: "block", priority: 10 }),
      rule({ id: "r-video", pattern: "youtube.com", action: "block", priority: 20 }),
      rule({
        id: "r-video-learning",
        pattern: "youtube.com/playlist*list=company*",
        matchKind: "url_pattern",
        action: "allow",
        priority: 15,
      }),
      rule({
        id: "r-admin",
        pattern: "https://intranet.corp.test/admin",
        matchKind: "url_pattern",
        action: "block",
        priority: 30,
      }),
    ]);

    const verdict = (url: string) => {
      const d = evaluateUrl(url, set, BLOCKLIST);
      return `${d.blocked ? "block" : "allow"}:${d.ruleId ?? "-"}`;
    };

    expect(verdict("https://www.facebook.com/feed")).toBe("block:r-social");
    expect(verdict("https://notfacebook.com/")).toBe("allow:-");
    expect(verdict("https://www.youtube.com/watch?v=abc")).toBe("block:r-video");
    expect(verdict("https://www.youtube.com/playlist?list=company-onboarding")).toBe("allow:r-video-learning");
    expect(verdict("https://intranet.corp.test/admin/users")).toBe("block:r-admin");
    expect(verdict("https://intranet.corp.test/administrators")).toBe("allow:-");
    expect(verdict("http://intranet.corp.test/admin")).toBe("allow:-"); // https was pinned
    expect(verdict("https://github.com/aems/repo")).toBe("allow:-");
  });
});

// ===========================================================================
// Routes
// ===========================================================================

interface Op {
  fn: string;
  args: unknown[];
}
interface Call {
  table: string;
  ops: Op[];
}
type Result = { data?: unknown; error?: unknown; count?: number };

const CHAINABLE = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "is",
  "in",
  "gte",
  "lte",
  "order",
  "limit",
];

function fakeSupabase(results: Record<string, Result[]>) {
  const calls: Call[] = [];

  const from = (table: string): unknown => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const queue = results[table] ? [...results[table]] : [];
    results[table] = queue;

    const settle = () => {
      const next = queue.shift() ?? {};
      return { data: next.data ?? null, error: next.error ?? null, count: next.count ?? null };
    };

    const builder: Record<string, unknown> = {};
    for (const fn of CHAINABLE) {
      builder[fn] = (...args: unknown[]) => {
        call.ops.push({ fn, args });
        return builder;
      };
    }
    builder.single = () => Promise.resolve(settle());
    builder.maybeSingle = () => Promise.resolve(settle());
    builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(onFulfilled, onRejected);
    return builder;
  };

  return { client: { from } as unknown as AemsSupabaseClient, calls };
}

const forTable = (calls: Call[], table: string): Call[] => calls.filter((c) => c.table === table);

function hasEq(call: Call, column: string, value: unknown): boolean {
  return call.ops.some((op) => op.fn === "eq" && op.args[0] === column && op.args[1] === value);
}

function payloadOf(call: Call, fn: "update" | "insert" | "upsert"): Record<string, unknown> | undefined {
  return call.ops.find((op) => op.fn === fn)?.args[0] as Record<string, unknown> | undefined;
}

function rowsOf(call: Call, fn: "insert" | "upsert"): Record<string, unknown>[] {
  return (call.ops.find((op) => op.fn === fn)?.args[0] ?? []) as Record<string, unknown>[];
}

const settingsRow = (over: Record<string, unknown> = {}) => ({
  company_id: COMPANY,
  enabled: true,
  mode: "blocklist",
  notice: "Ask your manager about this.",
  revision: 7,
  updated_by: ADMIN,
  updated_at: "2026-08-05T09:00:00Z",
  ...over,
});

const ruleRow = (over: Record<string, unknown> = {}) => ({
  id: RULE_A,
  priority: 10,
  action: "block",
  match_kind: "domain",
  pattern: "example.com",
  note: null,
  enabled: true,
  created_by: ADMIN,
  created_at: "2026-08-05T09:00:00Z",
  updated_at: "2026-08-05T09:00:00Z",
  ...over,
});

async function buildTestApp(opts: {
  supabase: AemsSupabaseClient;
  session?: SessionProfile;
  device?: DeviceContext;
}): Promise<FastifyInstance> {
  const app = Fastify();

  app.decorate("supabase", opts.supabase);
  app.decorate("env", { DEVICE_TOKEN_SECRET: "test-secret" } as Env);
  app.decorateRequest("session", undefined);
  app.decorateRequest("device", undefined);

  const guard =
    (allowed: SessionProfile["role"][]) => async (request: FastifyRequest, reply: FastifyReply) => {
      const session = opts.session;
      if (!session) {
        await reply.code(401).send({ error: "unauthorized", message: "no session", statusCode: 401 });
        return;
      }
      if (!allowed.includes(session.role)) {
        await reply.code(403).send({ error: "forbidden", message: "role", statusCode: 403 });
        return;
      }
      request.session = session;
    };

  app.decorate("requireUser", guard(["employee", "manager", "super_admin"]));
  app.decorate("requireManager", guard(["manager", "super_admin"]));
  app.decorate("requireSuperAdmin", guard(["super_admin"]));
  app.decorate("requireDevice", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!opts.device) {
      await reply.code(401).send({ error: "unauthorized", message: "no device", statusCode: 401 });
      return;
    }
    request.device = opts.device;
  });

  await app.register(restrictionRoutes, { prefix: "/api/restrictions" });
  return app;
}

describe("GET /api/restrictions", () => {
  it("is readable by an employee, because these are the terms they are filtered under", async () => {
    const { client, calls } = fakeSupabase({
      website_restriction_settings: [{ data: settingsRow() }],
      website_restriction_rules: [{ data: [ruleRow()] }],
    });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: "/api/restrictions" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      settings: { enabled: true, mode: "blocklist", revision: 7 },
      rules: [{ id: RULE_A, pattern: "example.com", matchKind: "domain" }],
    });
    expect(hasEq(forTable(calls, "website_restriction_settings")[0]!, "company_id", COMPANY)).toBe(true);
    expect(hasEq(forTable(calls, "website_restriction_rules")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("reports a rule that will never fire rather than letting an admin trust a typo", async () => {
    const { client } = fakeSupabase({
      website_restriction_settings: [{ data: settingsRow() }],
      website_restriction_rules: [{ data: [ruleRow({ pattern: "not a host", match_kind: "domain" })] }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "GET", url: "/api/restrictions" });

    expect(res.json().rejected).toHaveLength(1);
    expect(res.json().rejected[0]).toMatchObject({ ruleId: RULE_A });
  });

  it("answers safe defaults for a company that has never configured it", async () => {
    const { client } = fakeSupabase({
      website_restriction_settings: [{ data: null }],
      website_restriction_rules: [{ data: [] }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "GET", url: "/api/restrictions" });

    expect(res.json().settings).toMatchObject({ enabled: false, mode: "blocklist", revision: 0 });
  });

  it("is closed to an anonymous caller", async () => {
    const { client } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client });
    expect((await app.inject({ method: "GET", url: "/api/restrictions" })).statusCode).toBe(401);
  });
});

describe("GET /api/restrictions/enforcement", () => {
  it("hands the agent a revision it can poll, which is how a change lands without re-enrolment", async () => {
    const { client, calls } = fakeSupabase({
      website_restriction_settings: [{ data: settingsRow({ revision: 42 }) }],
      website_restriction_rules: [{ data: [ruleRow()] }],
    });
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({ method: "GET", url: "/api/restrictions/enforcement" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      revision: 42,
      enabled: true,
      mode: "blocklist",
      rules: [{ id: RULE_A, pattern: "example.com", action: "block" }],
    });
    // Scoped to the DEVICE's company, which is the only tenant boundary here.
    expect(hasEq(forTable(calls, "website_restriction_rules")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("does not ship a disabled rule to the extension at all", async () => {
    // Not shipped with a flag: the extension must not be able to enforce something an
    // admin switched off by getting one boolean wrong.
    const { client } = fakeSupabase({
      website_restriction_settings: [{ data: settingsRow() }],
      website_restriction_rules: [
        { data: [ruleRow(), ruleRow({ id: RULE_B, pattern: "off.test", enabled: false })] },
      ],
    });
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({ method: "GET", url: "/api/restrictions/enforcement" });

    expect(res.json().rules.map((r: { id: string }) => r.id)).toEqual([RULE_A]);
  });

  it("is closed to a caller with no device token", async () => {
    const { client } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    expect((await app.inject({ method: "GET", url: "/api/restrictions/enforcement" })).statusCode).toBe(401);
  });
});

describe("PUT /api/restrictions/settings", () => {
  function saveable() {
    return fakeSupabase({
      website_restriction_settings: [
        { data: settingsRow({ enabled: false, mode: "blocklist" }) },
        { data: settingsRow({ enabled: true, mode: "allowlist", revision: 8 }) },
      ],
      audit_log_entries: [{}],
    });
  }

  const BODY = { enabled: true, mode: "allowlist", notice: "Ask IT." };

  it("is closed to managers and employees", async () => {
    for (const session of [manager, alice]) {
      const { client, calls } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session });
      const res = await app.inject({ method: "PUT", url: "/api/restrictions/settings", payload: BODY });

      expect(res.statusCode, session.role).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  it("400s an unknown mode without touching the table", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PUT",
      url: "/api/restrictions/settings",
      payload: { ...BODY, mode: "kiosk" },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    // A readable sentence, not a JSON dump of the Zod issue array.
    expect(res.json().message).not.toContain("invalid_enum_value");
  });

  it("upserts, so a company that never configured it does not need hand-written SQL", async () => {
    const { client, calls } = saveable();
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "PUT", url: "/api/restrictions/settings", payload: BODY });

    expect(res.statusCode).toBe(200);
    expect(payloadOf(forTable(calls, "website_restriction_settings")[1]!, "upsert")).toMatchObject({
      company_id: COMPANY,
      enabled: true,
      mode: "allowlist",
      updated_by: ADMIN,
    });
  });

  it("records both the old and the new posture in the append-only trail", async () => {
    // Switching a company from block-list to allow-list changes what every browser on
    // the estate does with every page.
    const { client, calls } = saveable();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "PUT", url: "/api/restrictions/settings", payload: BODY });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      company_id: COMPANY,
      actor_id: ADMIN,
      action: "restriction.settings_updated",
      metadata: { mode: "allowlist", previousMode: "blocklist", previousEnabled: false },
    });
  });
});

describe("POST /api/restrictions/rules", () => {
  const DRAFT = { action: "block", matchKind: "domain", pattern: "facebook.com", priority: 10 };

  function creatable(count = 3) {
    return fakeSupabase({
      website_restriction_rules: [{ count }, { data: ruleRow({ pattern: "facebook.com" }) }],
      audit_log_entries: [{}],
    });
  }

  it("is closed to managers and employees", async () => {
    for (const session of [manager, alice]) {
      const { client, calls } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session });
      const res = await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: DRAFT });

      expect(res.statusCode, session.role).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a pattern the MATCHER cannot compile, not one a regex dislikes", async () => {
    // A pattern the API accepted and the matcher then silently skipped is a rule an
    // admin believes is in force and is not.
    for (const bad of [
      { ...DRAFT, pattern: "not a host" },
      { ...DRAFT, pattern: "*" },
      { ...DRAFT, matchKind: "url_pattern", pattern: "/" },
      { ...DRAFT, matchKind: "url_pattern", pattern: `x.com/${"*/".repeat(12)}` },
    ]) {
      const { client, calls } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session: admin });
      const res = await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: bad });

      expect(res.statusCode, bad.pattern).toBe(400);
      expect(calls).toHaveLength(0);
      expect(res.json().fields).toHaveProperty("pattern");
    }
  });

  it("accepts a pattern the matcher can compile", async () => {
    const { client, calls } = creatable();
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: DRAFT });

    expect(res.statusCode).toBe(201);
    expect(payloadOf(forTable(calls, "website_restriction_rules")[1]!, "insert")).toMatchObject({
      company_id: COMPANY,
      action: "block",
      match_kind: "domain",
      pattern: "facebook.com",
      created_by: ADMIN,
    });
  });

  it("stores a domain rule as the host it will actually match, not as the URL pasted in", async () => {
    // A row reading `https://www.facebook.com/feed?x=1` whose behaviour is "the whole
    // of facebook.com and every subdomain" is a rule an admin cannot reason about.
    for (const [typed, stored] of [
      ["https://www.facebook.com/feed?x=1", "www.facebook.com"],
      ["*.facebook.com", "facebook.com"],
      [".facebook.com", "facebook.com"],
      ["FaceBook.COM:443", "facebook.com"],
      // Validated as a real host, but the admin's own spelling comes back — punycode
      // conversion is the matcher's job, not the settings screen's.
      ["münchen.de", "münchen.de"],
    ] as const) {
      const { client, calls } = creatable();
      const app = await buildTestApp({ supabase: client, session: admin });
      const res = await app.inject({
        method: "POST",
        url: "/api/restrictions/rules",
        payload: { ...DRAFT, pattern: typed },
      });

      expect(res.statusCode, typed).toBe(201);
      expect(payloadOf(forTable(calls, "website_restriction_rules")[1]!, "insert"), typed).toMatchObject({
        pattern: stored,
      });
    }
  });

  it("leaves a URL pattern exactly as typed", async () => {
    const { client, calls } = creatable();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({
      method: "POST",
      url: "/api/restrictions/rules",
      payload: { ...DRAFT, matchKind: "url_pattern", pattern: "https://example.com/Admin/*" },
    });

    expect(payloadOf(forTable(calls, "website_restriction_rules")[1]!, "insert")).toMatchObject({
      pattern: "https://example.com/Admin/*",
    });
  });

  it("stamps the caller's company on the insert and counts only that company's rules", async () => {
    const { client, calls } = creatable();
    const app = await buildTestApp({ supabase: client, session: { ...admin, companyId: OTHER_COMPANY } });
    await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: DRAFT });

    const [count, insert] = forTable(calls, "website_restriction_rules");
    expect(hasEq(count!, "company_id", OTHER_COMPANY)).toBe(true);
    expect(payloadOf(insert!, "insert")).toMatchObject({ company_id: OTHER_COMPANY });
  });

  it("409s once the company is at the rule ceiling, without writing", async () => {
    const { client, calls } = creatable(MAX_RULES_PER_COMPANY);
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: DRAFT });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "rule_limit_reached" });
    expect(forTable(calls, "website_restriction_rules")).toHaveLength(1);
  });

  it("turns the unique-index violation into a 409, not a 500", async () => {
    const { client } = fakeSupabase({
      website_restriction_rules: [{ count: 1 }, { error: { code: "23505", message: "duplicate key" } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: DRAFT });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "rule_exists" });
  });

  it("audits the rule it created", async () => {
    const { client, calls } = creatable();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "POST", url: "/api/restrictions/rules", payload: DRAFT });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      company_id: COMPANY,
      actor_id: ADMIN,
      action: "restriction.rule_created",
      target_type: "website_restriction_rule",
      metadata: { pattern: "facebook.com", action: "block" },
    });
  });
});

describe("PATCH /api/restrictions/rules/:id", () => {
  it("cannot reach another company's rule, because the service-role key bypasses RLS", async () => {
    const { client, calls } = fakeSupabase({ website_restriction_rules: [{ data: null }] });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/restrictions/rules/${RULE_A}`,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect(hasEq(forTable(calls, "website_restriction_rules")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("400s a rule id that is not a uuid", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/restrictions/rules/not-a-uuid",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses a match-kind switch that would leave the existing pattern uncompilable", async () => {
    // `*/internal*` is a perfectly good URL pattern and is not a hostname at all.
    // Accepting the switch would leave a rule an admin believes is in force and that
    // the matcher silently skips.
    const { client, calls } = fakeSupabase({
      website_restriction_rules: [{ data: ruleRow({ match_kind: "url_pattern", pattern: "*/internal*" }) }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/restrictions/rules/${RULE_A}`,
      payload: { matchKind: "domain" },
    });

    expect(res.statusCode).toBe(400);
    // Read only; nothing was written.
    expect(forTable(calls, "website_restriction_rules")).toHaveLength(1);
  });

  it("rewrites the pattern when a kind switch changes what it means", async () => {
    // `example.com/admin*` as a domain rule is "all of example.com". That widening is
    // what the admin asked for by choosing the kind, but a row whose text still says
    // `/admin*` is a row nobody can reason about — so the text is brought into line.
    const { client, calls } = fakeSupabase({
      website_restriction_rules: [
        { data: ruleRow({ match_kind: "url_pattern", pattern: "example.com/admin*" }) },
        { data: ruleRow({ match_kind: "domain", pattern: "example.com" }) },
      ],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/restrictions/rules/${RULE_A}`,
      payload: { matchKind: "domain" },
    });

    expect(res.statusCode).toBe(200);
    expect(payloadOf(forTable(calls, "website_restriction_rules")[1]!, "update")).toEqual({
      match_kind: "domain",
      pattern: "example.com",
    });
  });

  it("writes only the fields that were sent, and audits what the rule used to say", async () => {
    const { client, calls } = fakeSupabase({
      website_restriction_rules: [
        { data: ruleRow({ priority: 10, enabled: true }) },
        { data: ruleRow({ priority: 90, enabled: false }) },
      ],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/restrictions/rules/${RULE_A}`,
      payload: { priority: 90, enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(payloadOf(forTable(calls, "website_restriction_rules")[1]!, "update")).toEqual({
      priority: 90,
      enabled: false,
    });
    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      action: "restriction.rule_updated",
      metadata: { previous: { priority: 10, enabled: true, pattern: "example.com" } },
    });
  });

  it("400s an empty patch rather than writing nothing and reporting success", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/restrictions/rules/${RULE_A}`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("is closed to managers", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/restrictions/rules/${RULE_A}`,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("DELETE /api/restrictions/rules/:id", () => {
  it("deletes only inside the caller's company and 404s otherwise", async () => {
    const { client, calls } = fakeSupabase({ website_restriction_rules: [{ data: null }] });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "DELETE", url: `/api/restrictions/rules/${RULE_A}` });

    expect(res.statusCode).toBe(404);
    expect(hasEq(forTable(calls, "website_restriction_rules")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("keeps the whole rule wording in the trail, because block records lose their rule_id", async () => {
    // website_block_events.rule_id is `on delete set null`. Without this the record of
    // what the rule blocked survives with nothing anywhere saying what it was.
    const { client, calls } = fakeSupabase({
      website_restriction_rules: [{ data: ruleRow({ note: "Non-work video" }) }],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "DELETE", url: `/api/restrictions/rules/${RULE_A}` });

    expect(res.statusCode).toBe(200);
    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      action: "restriction.rule_deleted",
      target_id: RULE_A,
      metadata: { pattern: "example.com", matchKind: "domain", note: "Non-work video" },
    });
  });

  it("is closed to managers", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: manager });
    expect((await app.inject({ method: "DELETE", url: `/api/restrictions/rules/${RULE_A}` })).statusCode).toBe(
      403,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/restrictions/events", () => {
  const EVENT = {
    clientEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    url: "https://www.facebook.com/feed?story=SECRET",
    blockedAt: "2026-08-05T10:00:00.000Z",
    ruleId: RULE_A,
  };
  const BODY = { deviceId: DEVICE, events: [EVENT] };

  function ingestible() {
    return fakeSupabase({
      consent_records: [{ data: { id: "c1" } }],
      website_restriction_settings: [{ data: settingsRow({ mode: "allowlist" }) }],
      website_restriction_rules: [{ data: [{ id: RULE_A, pattern: "facebook.com" }] }],
      website_block_events: [{ data: [{ id: 1 }] }],
    });
  }

  it("refuses to record anything without consent on file", async () => {
    // A blocked visit is a record of where somebody tried to go. That is monitoring
    // data whatever else it is.
    const { client, calls } = fakeSupabase({ consent_records: [{ data: null }] });
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({ method: "POST", url: "/api/restrictions/events", payload: BODY });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "consent_required" });
    expect(forTable(calls, "website_block_events")).toHaveLength(0);
  });

  it("refuses a batch whose deviceId does not match the token", async () => {
    const { client } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({
      method: "POST",
      url: "/api/restrictions/events",
      payload: { ...BODY, deviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("stores the URL without its query string", async () => {
    const { client, calls } = ingestible();
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({ method: "POST", url: "/api/restrictions/events", payload: BODY });

    expect(res.statusCode).toBe(200);
    const row = rowsOf(forTable(calls, "website_block_events")[0]!, "upsert")[0]!;
    expect(row.url).toBe("https://www.facebook.com/feed");
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(row.domain).toBe("www.facebook.com");
  });

  it("takes the audit text from the RULE ROW, never from the agent", async () => {
    // An agent is a binary on someone's laptop and must not be able to author the
    // record of why it blocked something.
    const { client, calls } = ingestible();
    const app = await buildTestApp({ supabase: client, device });
    await app.inject({
      method: "POST",
      url: "/api/restrictions/events",
      // The agent is not even given a field for this; prove a smuggled one is ignored.
      payload: { ...BODY, events: [{ ...EVENT, matchedPattern: "something-else.test" }] },
    });

    const row = rowsOf(forTable(calls, "website_block_events")[0]!, "upsert")[0]!;
    expect(row.matched_pattern).toBe("facebook.com");
    expect(row.rule_id).toBe(RULE_A);
    // And the mode is the company's current one, not the agent's claim.
    expect(row.mode).toBe("allowlist");
  });

  it("drops a rule id that does not belong to this company rather than storing it", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [{ data: { id: "c1" } }],
      website_restriction_settings: [{ data: settingsRow() }],
      // The company-scoped lookup finds nothing: the id is somebody else's.
      website_restriction_rules: [{ data: [] }],
      website_block_events: [{ data: [{ id: 1 }] }],
    });
    const app = await buildTestApp({ supabase: client, device });
    await app.inject({ method: "POST", url: "/api/restrictions/events", payload: BODY });

    const lookup = forTable(calls, "website_restriction_rules")[0]!;
    expect(hasEq(lookup, "company_id", COMPANY)).toBe(true);

    const row = rowsOf(forTable(calls, "website_block_events")[0]!, "upsert")[0]!;
    expect(row.rule_id).toBeNull();
    expect(row.matched_pattern).toBeNull();
  });

  it("stamps the device's own company, profile and device on every row", async () => {
    const { client, calls } = ingestible();
    const app = await buildTestApp({ supabase: client, device });
    await app.inject({ method: "POST", url: "/api/restrictions/events", payload: BODY });

    expect(rowsOf(forTable(calls, "website_block_events")[0]!, "upsert")[0]).toMatchObject({
      company_id: COMPANY,
      profile_id: ALICE,
      device_id: DEVICE,
    });
  });

  it("replays are idempotent, because agents flush buffered batches twice", async () => {
    const { client, calls } = ingestible();
    const app = await buildTestApp({ supabase: client, device });
    await app.inject({ method: "POST", url: "/api/restrictions/events", payload: BODY });

    const upsert = forTable(calls, "website_block_events")[0]!.ops.find((op) => op.fn === "upsert");
    expect(upsert?.args[1]).toMatchObject({
      onConflict: "device_id,client_event_id",
      ignoreDuplicates: true,
    });
  });

  it("counts a URL it cannot store instead of failing the whole batch or hiding it", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [{ data: { id: "c1" } }],
      website_restriction_settings: [{ data: settingsRow() }],
      website_restriction_rules: [{ data: [{ id: RULE_A, pattern: "facebook.com" }] }],
      website_block_events: [{ data: [{ id: 1 }] }],
    });
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({
      method: "POST",
      url: "/api/restrictions/events",
      payload: {
        deviceId: DEVICE,
        events: [EVENT, { ...EVENT, clientEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef", url: "%%%" }],
      },
    });

    expect(res.json()).toEqual({ accepted: 1, rejected: 1 });
    expect(rowsOf(forTable(calls, "website_block_events")[0]!, "upsert")).toHaveLength(1);
  });

  it("400s a malformed batch with a sentence, not a Zod dump", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, device });
    const res = await app.inject({
      method: "POST",
      url: "/api/restrictions/events",
      payload: { deviceId: DEVICE, events: [{ url: "https://x.test/", blockedAt: "yesterday" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain("invalid_string");
    expect(calls).toHaveLength(0);
  });

  it("is closed to a session without a device token", async () => {
    const { client } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    expect(
      (await app.inject({ method: "POST", url: "/api/restrictions/events", payload: BODY })).statusCode,
    ).toBe(401);
  });
});

describe("GET /api/restrictions/events", () => {
  const blockRow = {
    id: 1,
    profile_id: ALICE,
    device_id: DEVICE,
    rule_id: RULE_A,
    matched_pattern: "facebook.com",
    mode: "blocklist",
    domain: "www.facebook.com",
    url: "https://www.facebook.com/feed",
    blocked_at: "2026-08-05T10:00:00Z",
  };

  it("narrows an employee to their own rows without them asking", async () => {
    const { client, calls } = fakeSupabase({ website_block_events: [{ data: [blockRow] }] });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: "/api/restrictions/events" });

    expect(res.statusCode).toBe(200);
    const call = forTable(calls, "website_block_events")[0]!;
    expect(hasEq(call, "company_id", COMPANY)).toBe(true);
    expect(hasEq(call, "profile_id", ALICE)).toBe(true);
  });

  it("403s an employee asking for someone else, rather than quietly narrowing", async () => {
    // A UI bug should surface as a refusal, not as data that looks like someone else's.
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: `/api/restrictions/events?profileId=${BOB}` });

    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("lets a manager read the whole company and filter by person", async () => {
    const { client, calls } = fakeSupabase({ website_block_events: [{ data: [blockRow] }] });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: `/api/restrictions/events?profileId=${ALICE}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ domain: "www.facebook.com", matchedPattern: "facebook.com" });
    expect(hasEq(forTable(calls, "website_block_events")[0]!, "profile_id", ALICE)).toBe(true);
  });

  it("scopes an unfiltered manager read to the company and never wider", async () => {
    const { client, calls } = fakeSupabase({ website_block_events: [{ data: [] }] });
    const app = await buildTestApp({ supabase: client, session: { ...manager, companyId: OTHER_COMPANY } });
    await app.inject({ method: "GET", url: "/api/restrictions/events" });

    const call = forTable(calls, "website_block_events")[0]!;
    expect(hasEq(call, "company_id", OTHER_COMPANY)).toBe(true);
    expect(call.ops.some((op) => op.fn === "eq" && op.args[0] === "profile_id")).toBe(false);
  });

  it("400s a bad date range rather than returning everything", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: "/api/restrictions/events?from=yesterday" });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/restrictions/evaluate", () => {
  it("answers what would happen, so a rule set can be tested before it is trusted", async () => {
    const { client } = fakeSupabase({
      website_restriction_settings: [{ data: settingsRow() }],
      website_restriction_rules: [{ data: [ruleRow({ pattern: "facebook.com" })] }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "POST",
      url: "/api/restrictions/evaluate",
      payload: { url: "https://www.facebook.com/feed?story=1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      blocked: true,
      reason: "rule",
      ruleId: RULE_A,
      matchedPattern: "facebook.com",
      url: "https://www.facebook.com/feed",
      domain: "www.facebook.com",
    });
  });

  it("is open to an employee, which is better than finding out from a block page", async () => {
    const { client } = fakeSupabase({
      website_restriction_settings: [{ data: settingsRow() }],
      website_restriction_rules: [{ data: [] }],
    });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({
      method: "POST",
      url: "/api/restrictions/evaluate",
      payload: { url: "https://github.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ blocked: false, reason: "default" });
  });
});
