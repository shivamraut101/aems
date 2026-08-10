import { canViewOthers } from "@aems/auth";
import type { Json, TablesInsert, TablesUpdate } from "@aems/types";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import { validationFailure } from "../lib/validation.js";
import { ruleIdOf } from "../lib/website-restrictions.js";
import { resolveCollection } from "../plugins/context.js";

/**
 * Website restriction.
 *
 * `docs/scope.md` §8 files control features under *Later*; the client asked for
 * website restriction **by name** on 2026-08-05 and that override is recorded in
 * CLAUDE.md. Nothing else in §8 is in scope.
 *
 * Two halves live here:
 *
 *  1. **The matcher** — pure, exported, and the thing this feature actually is. It
 *     takes a URL and a company's compiled rules and answers blocked / not blocked
 *     with the rule that decided. No I/O, no Node built-ins beyond the WHATWG `URL`
 *     that exists in Deno and the browser too, so the identical function can run in
 *     Fastify, in an Edge Function, and inside the managed browser extension.
 *  2. **The routes** — CRUD for super admins, a read endpoint the agent and the
 *     extension poll, and the ingestion path that records what was stopped.
 *
 * A block that is not recorded is not auditable. The client will ask what was
 * stopped, and an employee is entitled to know which rule stopped them —
 * `docs/design.md` rules out a bare "blocked" screen — so every enforced block comes
 * back as a `website_block_events` row.
 */

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const RESTRICTION_MODES = ["blocklist", "allowlist"] as const;
export type RestrictionMode = (typeof RESTRICTION_MODES)[number];

export const RESTRICTION_ACTIONS = ["block", "allow"] as const;
export type RestrictionAction = (typeof RESTRICTION_ACTIONS)[number];

export const MATCH_KINDS = ["domain", "url_pattern"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/** One company-authored rule, as the wire and the matcher see it. */
export interface RestrictionRule {
  id: string;
  action: RestrictionAction;
  matchKind: MatchKind;
  pattern: string;
  /** Lower runs first; evaluation stops at the first rule that matches. */
  priority: number;
  /** A disabled rule is kept but never evaluated. Defaults to enabled. */
  enabled?: boolean | null;
}

export interface RestrictionSettings {
  enabled: boolean;
  mode: RestrictionMode;
}

/**
 * Why a decision came out the way it did. Carried into the block record and onto the
 * block page, because "blocked" with no reason is the surveillance framing
 * `docs/design.md` rules out.
 */
export type RestrictionReason =
  /** Enforcement is switched off for the company. */
  | "restrictions_disabled"
  /** Not http(s) — `chrome://`, `about:`, `file:`, `mailto:`. Never restricted. */
  | "scheme_not_restricted"
  /** Could not be read as a URL at all. */
  | "unparsable_url"
  /** A rule claimed it. `ruleId` and `matchedPattern` say which. */
  | "rule"
  /** No rule claimed it, so the company's mode decided. */
  | "default";

export interface RestrictionDecision {
  blocked: boolean;
  reason: RestrictionReason;
  ruleId: string | null;
  matchedPattern: string | null;
  mode: RestrictionMode;
}

/**
 * A URL split into the parts the matcher compares.
 *
 * `host`, `path` and `query` are the **matching** forms: lower-cased, punycode, and
 * percent-decoded once. `canonical` is the **storage** form and keeps the original
 * case and encoding — an audit record that silently lower-cased a case-sensitive path
 * is a record of something that did not happen.
 */
export interface TargetUrl {
  scheme: "http" | "https";
  /** ASCII/punycode, lower-case, no trailing dot, no port. IPv6 keeps its brackets. */
  host: string;
  /** Always populated: the default port is filled in, so `:443` can be matched. */
  port: string;
  /** Starts with `/`. Lower-cased and decoded once. */
  path: string;
  /** Without the leading `?`. Lower-cased and decoded once. `""` when absent. */
  query: string;
  /** `scheme://host[:port]/path` with the original case — **the query is dropped**. */
  canonical: string;
}

export type UrlParse =
  | { ok: true; target: TargetUrl }
  | { ok: false; reason: "unparsable_url" | "scheme_not_restricted" };

export interface CompiledRestrictionRule {
  id: string;
  action: RestrictionAction;
  matchKind: MatchKind;
  pattern: string;
  priority: number;
  matches: (target: TargetUrl) => boolean;
}

export interface RejectedRestrictionRule {
  ruleId: string;
  pattern: string;
  reason: string;
}

export interface CompiledRestrictionRuleSet {
  /** Usable rules, already in evaluation order. */
  rules: readonly CompiledRestrictionRule[];
  /** Rules that could not be compiled, so the settings screen can say which and why. */
  rejected: readonly RejectedRestrictionRule[];
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Longer than any real URL; past this we are being fed something, not browsing. */
const MAX_URL_LENGTH = 4096;

/** Matches the `pattern` column check. */
export const MAX_PATTERN_LENGTH = 400;

/**
 * `*` becomes `.*`, which backtracks polynomially when chained. Subjects are bounded
 * too, so this is belt and braces rather than the only defence.
 */
const MAX_WILDCARDS = 10;

/** How many rules one company may hold. The extension has to load every one of them. */
export const MAX_RULES_PER_COMPANY = 500;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * One decode pass, never two.
 *
 * `example.com/%61dmin` is `example.com/admin`, and a rule that misses it is a bypass
 * anybody can find. Decoding repeatedly is the opposite trap — `%2525` would keep
 * unwrapping and a pattern could match a URL the browser never requests.
 */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone `%` is not an error worth failing a block over.
    return value;
  }
}

function subjectForm(value: string): string {
  const bounded = value.length > MAX_URL_LENGTH ? value.slice(0, MAX_URL_LENGTH) : value;
  return decodeOnce(bounded).toLowerCase();
}

/**
 * Reads a URL as the matcher needs it.
 *
 * Anything that is not http(s) comes back as `scheme_not_restricted` rather than as a
 * failure: an allow-list that blocked `chrome://newtab`, `about:blank` or the
 * extension's own block page would brick the browser — and the page explaining the
 * block is one of those pages.
 *
 * A string with no scheme at all is read as `https://…`, because an agent that has
 * only a hostname is the normal case on Windows (see CLAUDE.md open item 6). A string
 * whose "scheme" is followed by a digit (`localhost:3000/x`) is a host and port, not a
 * scheme, and is read the same way.
 */
export function parseTargetUrl(raw: unknown): UrlParse {
  if (typeof raw !== "string") return { ok: false, reason: "unparsable_url" };

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: "unparsable_url" };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  const looksLikeHostPort = /^[a-z][a-z0-9+.-]*:\d/i.test(trimmed);

  if (scheme && !looksLikeHostPort) {
    const name = scheme[1]!.toLowerCase();
    if (name !== "http" && name !== "https") return { ok: false, reason: "scheme_not_restricted" };
    const url = tryUrl(trimmed);
    return url ? buildTarget(url) : { ok: false, reason: "unparsable_url" };
  }

  const url = tryUrl(`https://${trimmed}`);
  return url ? buildTarget(url) : { ok: false, reason: "unparsable_url" };
}

function buildTarget(url: URL): UrlParse {
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return { ok: false, reason: "scheme_not_restricted" };

  const scheme = protocol === "https:" ? "https" : "http";

  // `URL` already lower-cases and punycode-encodes an IDN host, and normalises the
  // decimal, octal and hex forms of an IPv4 literal to dotted quad. The trailing dot
  // of a fully-qualified name survives it and is not part of identity.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return { ok: false, reason: "unparsable_url" };

  const port = url.port || (scheme === "https" ? "443" : "80");
  const path = subjectForm(url.pathname) || "/";
  const query = subjectForm(url.search.replace(/^\?/, ""));

  const authority = url.port ? `${host}:${url.port}` : host;

  return {
    ok: true,
    target: {
      scheme,
      host,
      port,
      path,
      query,
      // The stored form. The query string is deliberately absent — see the column
      // comment on `website_block_events.url`.
      canonical: `${scheme}://${authority}${url.pathname || "/"}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

/**
 * The host an admin meant, with the structure around it removed but the spelling left
 * alone. Null when what they typed is not a host at all.
 *
 * Forgiving on the way in — people paste `https://example.com/pricing?ref=x`, write
 * `.example.com` out of cookie habit, and write `*.example.com` because that is what
 * every other product's syntax looks like. All four mean the same host.
 *
 * This is also what gets **stored** for a domain rule (see the write routes). A rule
 * whose text says `example.com/admin*` while its behaviour is "all of example.com" is
 * a rule an admin cannot reason about; canonicalising on write makes the widening
 * visible in the row and in the response instead of hiding it in the matcher.
 */
export function canonicalDomainPattern(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");

  const slash = value.indexOf("/");
  if (slash !== -1) value = value.slice(0, slash);

  // `user:pass@host` — the credentials are not part of the host, and a matcher that
  // thought they were would read `https://evil.com@example.com/` as evil.com.
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);

  value = stripPort(value);
  value = value.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!value || value.includes("*")) return null;

  // Validated, but not substituted: an admin who wrote `münchen.de` gets that back,
  // not `xn--mnchen-3ya.de`. The matcher does the punycode conversion at compile time.
  return toAsciiHost(value) === null ? null : value;
}

/**
 * The same host in the form the browser actually requests: ASCII, punycode, lower-case.
 * This is what the matcher compares against.
 */
export function normalizeDomainPattern(raw: string): string | null {
  const canonical = canonicalDomainPattern(raw);
  return canonical === null ? null : toAsciiHost(canonical);
}

function stripPort(value: string): string {
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value : value.slice(0, close + 1);
  }
  return value.replace(/:\d*$/, "");
}

/**
 * Real hostname syntax, applied *after* the URL parser has done the punycode work.
 *
 * The WHATWG parser is not a validator: it only refuses the "forbidden host code
 * points" (space, `#`, `/`, `:`, `<`, `>`, `?`, `@`, `[`, `\`, `]`, `^`, `|`), so it
 * hands back `!!!bad!!!`, `-lead.com` and `a..b` as though they were hosts. A rule
 * built on one of those compiles cleanly and then matches nothing for ever — an admin
 * believes a site is blocked (or, in allow-list mode, reachable) and it is not. A rule
 * that silently does nothing is the failure this codebase already shipped once, so a
 * typo is refused at the write rather than stored.
 *
 * Deliberately permissive where real networks are: single-label internal names
 * (`localhost`, `intranet`) are valid, and `_` appears in genuine internal DNS, so
 * neither is rejected. Only shapes DNS cannot represent are.
 */
const HOSTNAME_LABEL = "[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?";
const HOSTNAME = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);

function toAsciiHost(host: string): string | null {
  // IPv6 literals keep their brackets and are never IDN.
  if (host.startsWith("[")) return host.endsWith("]") ? host : null;

  const url = tryUrl(`https://${host}`);
  if (!url) return null;

  const parsed = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!parsed) return null;

  return HOSTNAME.test(parsed) ? parsed : null;
}

function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || IPV4.test(host);
}

/**
 * Suffix matching at a label boundary.
 *
 * `example.com` claims `example.com` and `app.example.com` and must **never** claim
 * `notexample.com` — a plain `endsWith` gets that wrong, and the difference is a
 * lookalike domain inheriting a real site's permission.
 *
 * An IP literal on either side is matched exactly. Labels are not hierarchical
 * rightwards in an address, so suffix logic would let a rule for `1.1` claim
 * `192.168.1.1`.
 */
export function hostMatchesDomain(pattern: string, host: string): boolean {
  const wanted = normalizeDomainPattern(pattern);
  if (!wanted) return false;

  const subject = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!subject) return false;

  if (isIpLiteral(wanted) || isIpLiteral(subject)) return subject === wanted;

  return subject === wanted || subject.endsWith(`.${wanted}`);
}

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

/**
 * `[scheme://]host[:port][/path][?query]`, with `*` as the **only** wildcard.
 *
 * `?` is not a single-character wildcard here and never will be — it is a URL
 * delimiter, and an admin who typed `/search?q=x` expecting a literal must get one.
 *
 * Semantics, each of which has a test:
 *
 * | Written                     | Means                                                      |
 * | --------------------------- | ---------------------------------------------------------- |
 * | `example.com`               | that host or any subdomain, any path, http or https         |
 * | `*.example.com`             | the same thing — the wildcard form people expect            |
 * | `https://example.com`       | https only                                                  |
 * | `example.com:3000`          | only when the URL resolves to port 3000 (defaults filled in)|
 * | `example.com/admin`         | `/admin`, `/admin/`, `/admin/x`, `/admin?y` — never `/administrator` |
 * | `example.com/files/*.pdf`   | glob over path and query                                    |
 *
 * A bare host means "or any subdomain" in a URL pattern too, deliberately unlike
 * Chrome's match patterns. The same admin writes both kinds of rule, and a block rule
 * that silently failed to cover `www.` is the failure that matters.
 */
interface CompiledUrlPattern {
  scheme: "http" | "https" | null;
  host: { kind: "any" } | { kind: "domain"; host: string } | { kind: "glob"; regex: RegExp };
  port: string | null;
  path: { kind: "any" } | { kind: "prefix"; value: string } | { kind: "glob"; regex: RegExp };
}

function globToRegExp(pattern: string): RegExp | null {
  const parts = pattern.split("*");
  if (parts.length - 1 > MAX_WILDCARDS) return null;

  const body = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  try {
    return new RegExp(`^${body}$`);
  } catch {
    return null;
  }
}

export function compileUrlPattern(raw: string): CompiledUrlPattern | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_PATTERN_LENGTH) return null;

  let rest = trimmed;
  let scheme: "http" | "https" | null = null;

  const schemeMatch = /^(\*|https?):\/\//.exec(rest);
  if (schemeMatch) {
    const name = schemeMatch[1]!;
    scheme = name === "*" ? null : (name as "http" | "https");
    rest = rest.slice(schemeMatch[0].length);
  }

  const slash = rest.indexOf("/");
  let hostPart = slash === -1 ? rest : rest.slice(0, slash);
  const pathPart = slash === -1 ? "" : rest.slice(slash);

  if (!hostPart) return null;

  // Port, if the admin pinned one. `[::1]:3000` keeps its brackets.
  let port: string | null = null;
  if (hostPart.startsWith("[")) {
    const close = hostPart.indexOf("]");
    if (close === -1) return null;
    const tail = hostPart.slice(close + 1);
    hostPart = hostPart.slice(0, close + 1);
    if (tail) {
      const portMatch = /^:(\d+|\*)$/.exec(tail);
      if (!portMatch) return null;
      port = portMatch[1] === "*" ? null : portMatch[1]!;
    }
  } else {
    const portMatch = /^(.*):(\d+|\*)$/.exec(hostPart);
    if (portMatch) {
      hostPart = portMatch[1]!;
      port = portMatch[2] === "*" ? null : portMatch[2]!;
      if (!hostPart) return null;
    }
  }

  let host: CompiledUrlPattern["host"];
  if (hostPart === "*") {
    host = { kind: "any" };
  } else if (hostPart.includes("*") && !/^\*\.[^*]+$/.test(hostPart)) {
    // A wildcard somewhere other than the leading label: `ads-*.example.com`. Matched
    // as a raw glob against the ASCII host, which means an IDN written this way will
    // not match — write it as a `domain` rule, which does the punycode conversion.
    const regex = globToRegExp(hostPart);
    if (!regex) return null;
    host = { kind: "glob", regex };
  } else {
    const normalized = normalizeDomainPattern(hostPart);
    if (!normalized) return null;
    host = { kind: "domain", host: normalized };
  }

  let path: CompiledUrlPattern["path"];
  if (!pathPart || pathPart === "/*" || pathPart === "*") {
    path = { kind: "any" };
  } else if (pathPart.includes("*")) {
    const regex = globToRegExp(pathPart);
    if (!regex) return null;
    path = { kind: "glob", regex };
  } else {
    path = { kind: "prefix", value: pathPart };
  }

  return { scheme, host, port, path };
}

/**
 * Prefix matching at a path-segment boundary — the same idea as the domain suffix
 * rule, applied leftwards. `/admin` covers `/admin/users` and not `/administrator`.
 */
function pathPrefixMatches(prefix: string, subject: string): boolean {
  if (subject === prefix) return true;
  if (prefix.endsWith("/")) return subject.startsWith(prefix);
  return subject.startsWith(`${prefix}/`) || subject.startsWith(`${prefix}?`);
}

function urlPatternMatches(compiled: CompiledUrlPattern, target: TargetUrl): boolean {
  if (compiled.scheme && compiled.scheme !== target.scheme) return false;
  if (compiled.port && compiled.port !== target.port) return false;

  switch (compiled.host.kind) {
    case "any":
      break;
    case "domain":
      if (!hostMatchesDomain(compiled.host.host, target.host)) return false;
      break;
    case "glob":
      if (!compiled.host.regex.test(target.host)) return false;
      break;
  }

  if (compiled.path.kind === "any") return true;

  const subject = target.query ? `${target.path}?${target.query}` : target.path;
  return compiled.path.kind === "glob"
    ? compiled.path.regex.test(subject)
    : pathPrefixMatches(compiled.path.value, subject);
}

// ---------------------------------------------------------------------------
// Rule compilation and evaluation
// ---------------------------------------------------------------------------

/**
 * Precompiles a company's rules once.
 *
 * Never throws. A rule that cannot be compiled is moved to `rejected` and skipped —
 * one malformed pattern must not decide the fate of every page in the company, in
 * either direction.
 */
export function compileRestrictionRules(
  rules: readonly RestrictionRule[],
): CompiledRestrictionRuleSet {
  const compiled: CompiledRestrictionRule[] = [];
  const rejected: RejectedRestrictionRule[] = [];

  for (const rule of rules) {
    if (rule.enabled === false) continue;

    const pattern = rule.pattern?.trim() ?? "";
    if (!pattern) {
      rejected.push({ ruleId: rule.id, pattern: rule.pattern ?? "", reason: "Pattern is empty" });
      continue;
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      rejected.push({
        ruleId: rule.id,
        pattern,
        reason: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
      });
      continue;
    }

    if (rule.matchKind === "domain") {
      const host = normalizeDomainPattern(pattern);
      if (!host) {
        rejected.push({ ruleId: rule.id, pattern, reason: "Not a hostname" });
        continue;
      }
      compiled.push({
        id: rule.id,
        action: rule.action,
        matchKind: "domain",
        pattern,
        priority: rule.priority,
        matches: (target) => hostMatchesDomain(host, target.host),
      });
      continue;
    }

    const urlPattern = compileUrlPattern(pattern);
    if (!urlPattern) {
      rejected.push({ ruleId: rule.id, pattern, reason: "Not a usable URL pattern" });
      continue;
    }
    compiled.push({
      id: rule.id,
      action: rule.action,
      matchKind: "url_pattern",
      pattern,
      priority: rule.priority,
      matches: (target) => urlPatternMatches(urlPattern, target),
    });
  }

  // Total and stable: two servers, and the extension, must reach the same verdict.
  // Priority, then id — the same rule `category_rules` uses, and for the same reason.
  compiled.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { rules: compiled, rejected };
}

/**
 * **The matcher.** Decides one URL against one company's rules.
 *
 * Failing open is deliberate everywhere it happens. A restriction system that blocks
 * what it could not parse takes the browser down with it, and the employee cannot
 * reach the page that would explain why.
 */
export function evaluateUrl(
  rawUrl: string,
  ruleSet: CompiledRestrictionRuleSet,
  settings: RestrictionSettings,
): RestrictionDecision {
  const mode = settings.mode;
  const base = { ruleId: null, matchedPattern: null, mode } as const;

  if (!settings.enabled) return { ...base, blocked: false, reason: "restrictions_disabled" };

  const parsed = parseTargetUrl(rawUrl);
  if (!parsed.ok) return { ...base, blocked: false, reason: parsed.reason };

  for (const rule of ruleSet.rules) {
    if (!rule.matches(parsed.target)) continue;
    return {
      blocked: rule.action === "block",
      reason: "rule",
      ruleId: rule.id,
      matchedPattern: rule.pattern,
      mode,
    };
  }

  // Nothing claimed it, so the posture decides: a block-list permits by default, an
  // allow-list refuses by default.
  return { ...base, blocked: mode === "allowlist", reason: "default" };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  priority: number;
  action: RestrictionAction;
  match_kind: MatchKind;
  pattern: string;
  note: string | null;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsRow {
  company_id: string;
  enabled: boolean;
  mode: RestrictionMode;
  notice: string | null;
  revision: number;
  updated_by: string | null;
  updated_at: string;
}

const RULE_COLUMNS = "id, priority, action, match_kind, pattern, note, enabled, created_by, created_at, updated_at";
const SETTINGS_COLUMNS = "company_id, enabled, mode, notice, revision, updated_by, updated_at";

/** Defaults for a company whose settings row has somehow not been created. */
const DEFAULT_SETTINGS = {
  enabled: false,
  mode: "blocklist" as RestrictionMode,
  notice: null,
  revision: 0,
  updatedAt: null as string | null,
};

function toRule(row: RuleRow) {
  return {
    id: row.id,
    priority: row.priority,
    action: row.action,
    matchKind: row.match_kind,
    pattern: row.pattern,
    note: row.note,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSettings(row: SettingsRow | null) {
  if (!row) return DEFAULT_SETTINGS;
  return {
    enabled: row.enabled,
    mode: row.mode,
    notice: row.notice,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function toMatcherRules(rows: readonly RuleRow[]): RestrictionRule[] {
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    matchKind: row.match_kind,
    pattern: row.pattern,
    priority: row.priority,
    enabled: row.enabled,
  }));
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * A pattern is validated by *compiling* it, not by a regex over the text, and what
 * gets stored is the form the matcher will actually use.
 *
 * The matcher is the authority on what a pattern means, so it must also be the
 * authority on whether one is usable. A pattern the API accepted and the matcher then
 * silently skipped is a rule an admin believes is in force and is not.
 *
 * Returns null when the pattern cannot be matched at all.
 */
export function storedPatternFor(kind: MatchKind, pattern: string): string | null {
  if (kind === "domain") return canonicalDomainPattern(pattern);
  // A URL pattern is stored as typed: `compileUrlPattern` lower-cases for matching,
  // and matching is case-insensitive by design, so the text does not misrepresent the
  // behaviour the way a domain rule carrying a path would.
  return compileUrlPattern(pattern) === null ? null : pattern.trim();
}

const PATTERN_REJECTED =
  "That pattern cannot be matched against a URL. A domain rule wants a hostname such as example.com; a URL pattern wants example.com/path with * as the only wildcard.";

const ruleDraftSchema = z
  .object({
    action: z.enum(RESTRICTION_ACTIONS),
    matchKind: z.enum(MATCH_KINDS),
    pattern: z.string().trim().min(1).max(MAX_PATTERN_LENGTH),
    priority: z.number().int().min(0).max(100_000).default(100),
    note: z.string().trim().min(1).max(300).nullish(),
    enabled: z.boolean().default(true),
  })
  .refine((draft) => storedPatternFor(draft.matchKind, draft.pattern) !== null, {
    path: ["pattern"],
    message: PATTERN_REJECTED,
  });

const rulePatchSchema = z
  .object({
    action: z.enum(RESTRICTION_ACTIONS).optional(),
    matchKind: z.enum(MATCH_KINDS).optional(),
    pattern: z.string().trim().min(1).max(MAX_PATTERN_LENGTH).optional(),
    priority: z.number().int().min(0).max(100_000).optional(),
    note: z.string().trim().min(1).max(300).nullish(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to change.",
  });

const settingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(RESTRICTION_MODES),
  notice: z.string().trim().min(1).max(500).nullish(),
});

const blockEventsSchema = z.object({
  deviceId: z.string().uuid(),
  events: z
    .array(
      z.object({
        clientEventId: z.string().uuid(),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        blockedAt: z.string().datetime({ offset: true }),
        /**
         * What the extension enforced. Verified against this company before it is stored.
         *
         * A number is the `declarativeNetRequest` id, which is the only identity the
         * browser has — the rule's uuid is deliberately never sent to an extension. It
         * is resolved back below against this company's own rules, so a fabricated id
         * resolves to null rather than to somebody else's rule.
         */
        ruleId: z.union([z.string().uuid(), z.number().int().positive()]).nullish(),
      }),
    )
    .min(1)
    .max(200),
});

const eventQuerySchema = z.object({
  profileId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const evaluateSchema = z.object({
  url: z.string().min(1).max(MAX_URL_LENGTH),
});

const ruleIdSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const restrictionRoutes: FastifyPluginAsync = async (app) => {
  async function loadSettings(companyId: string): Promise<SettingsRow | null> {
    const { data } = await app.supabase
      .from("website_restriction_settings")
      .select(SETTINGS_COLUMNS)
      .eq("company_id", companyId)
      .maybeSingle();
    return (data ?? null) as SettingsRow | null;
  }

  async function loadRules(companyId: string): Promise<RuleRow[]> {
    const { data } = await app.supabase
      .from("website_restriction_rules")
      .select(RULE_COLUMNS)
      .eq("company_id", companyId)
      .order("priority", { ascending: true })
      .order("id", { ascending: true });
    return (data ?? []) as RuleRow[];
  }

  /**
   * The whole rule set, for the dashboard.
   *
   * Readable by **everyone signed in, employees included**, for the same reason
   * `GET /api/policies/current` is: these are the terms a person is being filtered
   * under. A filter whose rules are hidden from the people it applies to is the
   * surveillance framing `docs/design.md` rules out, and non-negotiable #3 already
   * says people read their own data.
   */
  app.get("/", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;
    const [settings, rules] = await Promise.all([
      loadSettings(session.companyId),
      loadRules(session.companyId),
    ]);

    // Compiled here so the settings screen can mark a rule that will never fire,
    // rather than letting an admin believe a typo is protecting them.
    const compiled = compileRestrictionRules(toMatcherRules(rules));

    return {
      settings: toSettings(settings),
      rules: rules.map(toRule),
      rejected: compiled.rejected,
    };
  });

  /**
   * What the agent and the managed extension enforce.
   *
   * **Device-authenticated, and deliberately not consent-gated.** Enforcement is not
   * collection: an employee who withdraws consent stops being *observed*, and it would
   * be perverse if withdrawing consent also switched off the company's browsing rules —
   * that would turn consent revocation into an enforcement bypass. Recording a block
   * (`POST /events`, below) *is* collection and is gated normally.
   *
   * `revision` is the reason this endpoint exists at all. Policy reaches an agent only
   * at enrolment today; a restriction that behaved the same way would mean every rule
   * change was silently ineffective on every machine already in the field. The agent
   * polls, compares the number, and reloads only when it moved.
   */
  app.get("/enforcement", { preHandler: app.requireDevice }, async (request) => {
    const device = request.device!;
    const [settings, rules] = await Promise.all([
      loadSettings(device.companyId),
      loadRules(device.companyId),
    ]);

    const resolved = toSettings(settings);

    return {
      revision: resolved.revision,
      enabled: resolved.enabled,
      mode: resolved.mode,
      notice: resolved.notice,
      // Disabled rules are dropped here rather than shipped with a flag: the extension
      // should not be able to enforce something the admin switched off by getting one
      // boolean wrong.
      rules: rules
        .filter((row) => row.enabled)
        .map((row) => ({
          id: row.id,
          action: row.action,
          matchKind: row.match_kind,
          pattern: row.pattern,
          priority: row.priority,
          note: row.note,
        })),
    };
  });

  /**
   * "What would happen to this URL?"
   *
   * Open to everyone signed in. For an admin it is how a rule set gets tested before
   * it is trusted; for an employee it is the honest answer to "am I allowed to open
   * this", which beats finding out from a block page.
   */
  app.post("/evaluate", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = evaluateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const [settings, rules] = await Promise.all([
      loadSettings(session.companyId),
      loadRules(session.companyId),
    ]);

    const resolved = toSettings(settings);
    const compiled = compileRestrictionRules(toMatcherRules(rules));
    const decision = evaluateUrl(parsed.data.url, compiled, {
      enabled: resolved.enabled,
      mode: resolved.mode,
    });

    const target = parseTargetUrl(parsed.data.url);

    return {
      ...decision,
      url: target.ok ? target.target.canonical : null,
      domain: target.ok ? target.target.host : null,
    };
  });

  /**
   * Turns enforcement on or off and picks the posture.
   *
   * Upserts, because a company that has never configured restriction may have no row —
   * a fresh tenant must not need hand-written SQL to switch the feature on.
   */
  app.put("/settings", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const body = parsed.data;
    const before = await loadSettings(session.companyId);

    const { data, error } = await app.supabase
      .from("website_restriction_settings")
      .upsert(
        {
          company_id: session.companyId,
          enabled: body.enabled,
          mode: body.mode,
          notice: body.notice ?? null,
          updated_by: session.profileId,
        },
        { onConflict: "company_id" },
      )
      .select(SETTINGS_COLUMNS)
      .single();

    if (error || !data) {
      return reply.code(500).send({
        error: "restriction_settings_write_failed",
        message: error?.message ?? "Could not save restriction settings",
        statusCode: 500,
      });
    }

    // Switching a company from block-list to allow-list changes what every browser on
    // the estate does with every page. Both the old and the new posture go into the
    // append-only trail, as a policy change does.
    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "restriction.settings_updated",
        targetType: "website_restriction_settings",
        targetId: session.companyId,
        metadata: {
          enabled: body.enabled,
          mode: body.mode,
          previousEnabled: before?.enabled ?? null,
          previousMode: before?.mode ?? null,
        } as Json,
      },
      app.log,
    );

    return toSettings(data as SettingsRow);
  });

  app.post("/rules", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const parsed = ruleDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const draft = parsed.data;

    // Non-null: the schema refused anything `storedPatternFor` cannot canonicalise.
    const pattern = storedPatternFor(draft.matchKind, draft.pattern) ?? draft.pattern;

    // The extension loads every rule on every browser; an unbounded list is a slow
    // startup on someone's laptop, not an abstract concern.
    const { count, error: countError } = await app.supabase
      .from("website_restriction_rules")
      .select("id", { count: "exact", head: true })
      .eq("company_id", session.companyId);

    if (countError) {
      return reply.code(500).send({
        error: "restriction_rule_read_failed",
        message: countError.message,
        statusCode: 500,
      });
    }

    if ((count ?? 0) >= MAX_RULES_PER_COMPANY) {
      return reply.code(409).send({
        error: "rule_limit_reached",
        message: `A company may hold at most ${MAX_RULES_PER_COMPANY} restriction rules.`,
        statusCode: 409,
      });
    }

    const { data, error } = await app.supabase
      .from("website_restriction_rules")
      .insert({
        company_id: session.companyId,
        action: draft.action,
        match_kind: draft.matchKind,
        pattern,
        priority: draft.priority,
        note: draft.note ?? null,
        enabled: draft.enabled,
        created_by: session.profileId,
      })
      .select(RULE_COLUMNS)
      .single();

    if (error || !data) {
      const duplicate = error?.code === "23505";
      return reply.code(duplicate ? 409 : 500).send({
        error: duplicate ? "rule_exists" : "restriction_rule_write_failed",
        message: duplicate
          ? "A rule with that pattern already exists. Edit the existing rule instead of adding a second one."
          : (error?.message ?? "Could not save the rule"),
        statusCode: duplicate ? 409 : 500,
      });
    }

    const rule = data as RuleRow;

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "restriction.rule_created",
        targetType: "website_restriction_rule",
        targetId: rule.id,
        metadata: {
          action: draft.action,
          matchKind: draft.matchKind,
          pattern,
          priority: draft.priority,
          enabled: draft.enabled,
        } as Json,
      },
      app.log,
    );

    return reply.code(201).send(toRule(rule));
  });

  app.patch("/rules/:id", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const id = ruleIdSchema.safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply
        .code(400)
        .send({ error: "invalid_params", message: "Rule id is not valid", statusCode: 400 });
    }

    const parsed = rulePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const patch = parsed.data;

    // Read first, both to 404 honestly and to record what the rule used to say.
    // Company-scoped: the service-role key bypasses RLS, so this filter is the whole
    // tenant boundary and its absence would let one admin edit another company's rules
    // by guessing a uuid.
    const { data: existing } = await app.supabase
      .from("website_restriction_rules")
      .select(RULE_COLUMNS)
      .eq("id", id.data)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!existing) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "Rule not found", statusCode: 404 });
    }

    const before = existing as RuleRow;

    // Either half can invalidate the pair, so both are re-checked together whenever
    // one moves: switching `*/internal*` from url_pattern to domain leaves a pattern
    // the domain matcher will never compile, and a rule an admin believes is in force.
    const touchesPattern = patch.pattern !== undefined || patch.matchKind !== undefined;
    const matchKind = patch.matchKind ?? before.match_kind;

    const update: TablesUpdate<"website_restriction_rules"> = {};

    if (touchesPattern) {
      const stored = storedPatternFor(matchKind, patch.pattern ?? before.pattern);
      if (stored === null) {
        return reply.code(400).send({
          error: "invalid_body",
          message: PATTERN_REJECTED,
          statusCode: 400,
          fields: { pattern: "Not a usable pattern for this match type." },
        });
      }
      // Written whenever the pair moved, even if only the kind was sent: converting
      // `example.com/admin*` to a domain rule stores `example.com`, so the row says
      // what it does rather than keeping text the domain matcher ignores.
      if (stored !== before.pattern) update.pattern = stored;
    }

    if (patch.action !== undefined) update.action = patch.action;
    if (patch.matchKind !== undefined) update.match_kind = patch.matchKind;
    if (patch.priority !== undefined) update.priority = patch.priority;
    if (patch.note !== undefined) update.note = patch.note ?? null;
    if (patch.enabled !== undefined) update.enabled = patch.enabled;

    // A patch that canonicalises to exactly what is already stored. `.update({})` is a
    // no-op that some drivers turn into an error, and there is nothing to audit.
    if (Object.keys(update).length === 0) return toRule(before);

    const { data, error } = await app.supabase
      .from("website_restriction_rules")
      .update(update)
      .eq("id", id.data)
      .eq("company_id", session.companyId)
      .select(RULE_COLUMNS)
      .single();

    if (error || !data) {
      const duplicate = error?.code === "23505";
      return reply.code(duplicate ? 409 : 500).send({
        error: duplicate ? "rule_exists" : "restriction_rule_write_failed",
        message: duplicate
          ? "A rule with that pattern already exists."
          : (error?.message ?? "Could not save the rule"),
        statusCode: duplicate ? 409 : 500,
      });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "restriction.rule_updated",
        targetType: "website_restriction_rule",
        targetId: id.data,
        metadata: {
          changed: update as Json,
          previous: {
            action: before.action,
            matchKind: before.match_kind,
            pattern: before.pattern,
            priority: before.priority,
            enabled: before.enabled,
          },
        } as Json,
      },
      app.log,
    );

    return toRule(data as RuleRow);
  });

  app.delete("/rules/:id", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const id = ruleIdSchema.safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply
        .code(400)
        .send({ error: "invalid_params", message: "Rule id is not valid", statusCode: 400 });
    }

    const session = request.session!;

    const { data, error } = await app.supabase
      .from("website_restriction_rules")
      .delete()
      .eq("id", id.data)
      .eq("company_id", session.companyId)
      .select(RULE_COLUMNS)
      .maybeSingle();

    if (error) {
      return reply.code(500).send({
        error: "restriction_rule_write_failed",
        message: error.message,
        statusCode: 500,
      });
    }

    if (!data) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "Rule not found", statusCode: 404 });
    }

    const removed = data as RuleRow;

    // The rule's whole wording goes into the trail. `website_block_events.rule_id` is
    // `on delete set null`, so without this the record of what it blocked would survive
    // with nothing left anywhere saying what it was.
    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "restriction.rule_deleted",
        targetType: "website_restriction_rule",
        targetId: removed.id,
        metadata: {
          action: removed.action,
          matchKind: removed.match_kind,
          pattern: removed.pattern,
          priority: removed.priority,
          note: removed.note,
        } as Json,
      },
      app.log,
    );

    return { deleted: true as const, id: removed.id };
  });

  /**
   * Records blocks the extension enforced.
   *
   * Consent-gated like every other observation: a blocked visit is a record of where
   * somebody tried to go, which is monitoring data whatever else it is.
   *
   * The agent says *which rule* it enforced; the server decides what that means. The
   * rule id is looked up inside this company (a foreign id becomes null rather than a
   * cross-tenant reference), the pattern text is read from the rule row rather than
   * taken from the request, and the URL is re-parsed here so the stored form is ours.
   * An agent is a binary on someone's laptop and must not be able to author audit text.
   */
  app.post("/events", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = blockEventsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_body"));
    }

    const device = request.device!;
    const body = parsed.data;

    if (body.deviceId !== device.deviceId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Token does not match device", statusCode: 403 });
    }

    // Not gated by data type: a block event is an enforcement record — proof the agent
    // refused a page — rather than an observation the admin can switch off.
    const consent = await resolveCollection(app.supabase, device);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const claimed = [...new Set(body.events.map((e) => e.ruleId).filter((v): v is string => typeof v === "string"))];

    // A numeric claim cannot be looked up by primary key, because the number *is* a hash
    // of the uuid. Resolving it means hashing this company's rules and comparing — a
    // handful of rows, and the company filter is what keeps a guessed number from ever
    // naming a rule in another tenant.
    const claimsNumericRule = body.events.some((e) => typeof e.ruleId === "number");

    // The company's posture and the rules the agent claims to have enforced are
    // independent lookups, both behind the consent gate above, so they go in one round
    // trip instead of two. Each is still scoped to the device's own company — that
    // filter is what turns a foreign rule id into null rather than a cross-tenant read.
    const [settings, claimedRules] = await Promise.all([
      loadSettings(device.companyId),
      claimsNumericRule
        ? app.supabase
            .from("website_restriction_rules")
            .select("id, pattern")
            .eq("company_id", device.companyId)
        : claimed.length > 0
          ? app.supabase
              .from("website_restriction_rules")
              .select("id, pattern")
              .eq("company_id", device.companyId)
              .in("id", claimed)
          : { data: [] },
    ]);

    const mode = settings?.mode ?? "blocklist";

    const patterns = new Map<string, string>();
    /** `declarativeNetRequest` id -> the uuid it was derived from, for this company only. */
    const byNumericId = new Map<number, string>();
    for (const row of (claimedRules.data ?? []) as { id: string; pattern: string }[]) {
      patterns.set(row.id, row.pattern);
      if (claimsNumericRule) byNumericId.set(ruleIdOf(row.id), row.id);
    }

    const rows: TablesInsert<"website_block_events">[] = [];
    let unparsable = 0;

    for (const event of body.events) {
      const target = parseTargetUrl(event.url);
      if (!target.ok) {
        // Nothing to file it under. Counted back so a broken extension shows up as a
        // number rather than as silence.
        unparsable += 1;
        continue;
      }

      const resolved =
        typeof event.ruleId === "number" ? (byNumericId.get(event.ruleId) ?? null) : event.ruleId;
      const ruleId = resolved && patterns.has(resolved) ? resolved : null;

      rows.push({
        company_id: device.companyId,
        profile_id: device.profileId,
        device_id: device.deviceId,
        rule_id: ruleId,
        matched_pattern: ruleId ? (patterns.get(ruleId) ?? null) : null,
        mode,
        domain: target.target.host.slice(0, 253),
        url: target.target.canonical.slice(0, 2048),
        blocked_at: event.blockedAt,
        client_event_id: event.clientEventId,
      });
    }

    if (rows.length === 0) return { accepted: 0, rejected: unparsable };

    const { data, error } = await app.supabase
      .from("website_block_events")
      .upsert(rows, { onConflict: "device_id,client_event_id", ignoreDuplicates: true })
      .select("id");

    if (error) {
      return reply
        .code(500)
        .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
    }

    return { accepted: data?.length ?? 0, rejected: unparsable };
  });

  /**
   * What was stopped.
   *
   * An employee reads their own record — non-negotiable #3, and the only way the block
   * page's "which policy was this?" question has an answer. A `profileId` they do not
   * own is refused rather than quietly narrowed, so a UI bug surfaces as a 403 instead
   * of as data that looks like someone else's.
   */
  app.get("/events", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = eventQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_query"));
    }

    const session = request.session!;
    const query = parsed.data;

    // `canViewOthers` rather than a role comparison: asking what a role MAY do fails
    // closed when a role is added to the schema and forgotten here.
    const privileged = canViewOthers(session.role);
    if (!privileged && query.profileId && query.profileId !== session.profileId) {
      return reply.code(403).send({
        error: "forbidden",
        message: "You can only read your own restriction history",
        statusCode: 403,
      });
    }

    const profileId = privileged ? query.profileId : session.profileId;

    let builder = app.supabase
      .from("website_block_events")
      .select("id, profile_id, device_id, rule_id, matched_pattern, mode, domain, url, blocked_at")
      .eq("company_id", session.companyId);

    if (profileId) builder = builder.eq("profile_id", profileId);
    if (query.from) builder = builder.gte("blocked_at", query.from);
    if (query.to) builder = builder.lte("blocked_at", query.to);

    const { data, error } = await builder
      .order("blocked_at", { ascending: false })
      .limit(query.limit);

    if (error) {
      return reply
        .code(500)
        .send({ error: "restriction_events_read_failed", message: error.message, statusCode: 500 });
    }

    return (data ?? []).map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      deviceId: row.device_id,
      ruleId: row.rule_id,
      matchedPattern: row.matched_pattern,
      mode: row.mode,
      domain: row.domain,
      url: row.url,
      blockedAt: row.blocked_at,
    }));
  });
};
