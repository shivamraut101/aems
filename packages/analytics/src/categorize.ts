/**
 * Activity categorisation.
 *
 * Pure, no I/O, no Node built-ins — so the identical function runs in Fastify at
 * ingestion, in a Deno Edge Function inside a worker, and under Vitest. That is what
 * lets a rule added on Tuesday relabel Monday's history without a backfill: reads can
 * recompute instead of trusting `activity_events.category`.
 *
 * Deliberately NOT on the agent. Rules are company data that changes without a
 * release, and an agent-side engine would have to be rebuilt for Android and again
 * for any Phase 2 desktop rewrite.
 */

export type Productivity = "productive" | "neutral" | "unproductive";

export const PRODUCTIVITY_VALUES: readonly Productivity[] = [
  "productive",
  "neutral",
  "unproductive",
];

/** Label given to activity no rule claims. */
export const UNCATEGORIZED = "Uncategorized";

/** Separator between path segments in the stored `activity_events.category` text. */
export const CATEGORY_SEPARATOR = " > ";

/**
 * One company-authored classification rule.
 *
 * At least one of the three match fields must be set; every field that *is* set must
 * match, so a rule narrows rather than widens as an admin adds conditions.
 */
export interface CategoryRule {
  id: string;
  /** Hierarchy, outermost first: `["Work", "Development"]`. */
  path: string[];
  productivity: Productivity;
  /** Lower runs first. Evaluation stops at the first rule that matches. */
  priority: number;
  /** Regex source, tested against the application name. */
  matchApp?: string | null;
  /**
   * A bare hostname is matched as a suffix (see {@link matchesDomainPattern});
   * anything containing regex syntax is matched as an unanchored regex.
   */
  matchDomain?: string | null;
  /** Regex source, tested against the window title. */
  matchTitle?: string | null;
  /** Defaults to true. Never applied to literal domain matching, which is always case-insensitive. */
  ignoreCase?: boolean | null;
}

/** The three fields a rule can look at, as an event supplies them. */
export interface CategorizableEvent {
  appName: string;
  windowTitle?: string | null;
  domain?: string | null;
}

/** An `activity_events` row, as the database column names it. */
export interface ActivityRowLike {
  app_name: string;
  window_title?: string | null;
  domain?: string | null;
}

export interface Categorization {
  /** `path` joined for storage in `activity_events.category`. */
  category: string;
  path: readonly string[];
  productivity: Productivity;
  /** null when nothing matched and the fallback applied. */
  ruleId: string | null;
}

export interface RejectedRule {
  ruleId: string;
  field: "app" | "domain" | "title" | "rule";
  reason: string;
}

interface CompiledRule {
  id: string;
  path: readonly string[];
  category: string;
  productivity: Productivity;
  priority: number;
  app: RegExp | null;
  title: RegExp | null;
  domain: DomainMatcher | null;
}

export interface CompiledRuleSet {
  /** Usable rules, already in evaluation order. */
  rules: readonly CompiledRule[];
  /** Rules that could not be compiled, so a settings UI can say which and why. */
  rejected: readonly RejectedRule[];
}

type DomainMatcher =
  | { kind: "suffix"; host: string }
  | { kind: "regex"; pattern: RegExp };

/**
 * The answer for activity no rule claimed.
 *
 * `neutral`, never `unproductive`: an application nobody has written a rule for is
 * evidence of nothing, and a product positioned as workforce intelligence must not
 * count "we don't know" against a person.
 */
export const UNCATEGORIZED_RESULT: Categorization = Object.freeze({
  category: UNCATEGORIZED,
  path: Object.freeze([UNCATEGORIZED]),
  productivity: "neutral",
  ruleId: null,
});

/**
 * Longest subject any pattern is run against.
 *
 * The API already caps window titles at 500 characters, so this only bites on data
 * that should not exist. A bounded scan on absurd input beats an unbounded one:
 * even a linear-time regex over a megabyte, twenty thousand times in one report,
 * is a timeout.
 */
const MAX_SUBJECT_LENGTH = 1024;

/** Beyond this a pattern is not a category rule, it is an attack surface. */
const MAX_PATTERN_LENGTH = 400;

/** A repetition count above this is treated as unbounded for risk purposes. */
const LARGE_REPETITION = 20;

/** A pattern of only hostname characters is matched as a suffix, not as a regex. */
const BARE_HOSTNAME = /^[a-z0-9][a-z0-9.-]*$/i;

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Precompiles a company's rules once so a report over twenty thousand events does not
 * rebuild the same RegExp objects twenty thousand times.
 *
 * Never throws. A rule that cannot be compiled is moved to `rejected` and skipped —
 * one malformed rule must not stop ingestion for the whole company.
 */
export function compileRules(rules: readonly CategoryRule[]): CompiledRuleSet {
  const compiled: CompiledRule[] = [];
  const rejected: RejectedRule[] = [];

  for (const rule of rules) {
    const hasApp = isSet(rule.matchApp);
    const hasDomain = isSet(rule.matchDomain);
    const hasTitle = isSet(rule.matchTitle);

    if (!hasApp && !hasDomain && !hasTitle) {
      rejected.push({
        ruleId: rule.id,
        field: "rule",
        reason: "A rule must match on at least one of application, domain or window title",
      });
      continue;
    }

    const ignoreCase = rule.ignoreCase !== false;
    const app = hasApp ? compilePattern(rule.matchApp as string, ignoreCase) : { ok: true as const, value: null };
    const title = hasTitle ? compilePattern(rule.matchTitle as string, ignoreCase) : { ok: true as const, value: null };
    const domain = hasDomain ? compileDomain(rule.matchDomain as string, ignoreCase) : { ok: true as const, value: null };

    // One unusable field rejects the whole rule. Dropping just the bad field would
    // *widen* the rule — an app+title rule would quietly become app-only and start
    // claiming activity it was never written to claim.
    const failure =
      (!app.ok && { field: "app" as const, reason: app.reason }) ||
      (!domain.ok && { field: "domain" as const, reason: domain.reason }) ||
      (!title.ok && { field: "title" as const, reason: title.reason });

    if (failure) {
      rejected.push({ ruleId: rule.id, field: failure.field, reason: failure.reason });
      continue;
    }

    const path = rule.path.length > 0 ? [...rule.path] : [UNCATEGORIZED];

    compiled.push({
      id: rule.id,
      path,
      category: formatCategoryPath(path),
      productivity: rule.productivity,
      priority: rule.priority,
      app: app.ok ? app.value : null,
      title: title.ok ? title.value : null,
      domain: domain.ok ? domain.value : null,
    });
  }

  // Ordered evaluation, first match wins. ActivityWatch picks the deepest matching
  // path instead; that is elegant for a personal tool and unexplainable to an admin
  // defending a report to an employee. Depth and id only break a priority tie, so
  // the order is total and two servers always agree.
  compiled.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.path.length - a.path.length ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return { rules: compiled, rejected };
}

type CompileResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function compilePattern(source: string, ignoreCase: boolean): CompileResult<RegExp> {
  const risk = patternRisk(source);
  if (risk) return { ok: false, reason: risk };

  try {
    return { ok: true, value: new RegExp(source, ignoreCase ? "iu" : "u") };
  } catch {
    // `u` mode rejects patterns that legacy mode tolerates; retry before giving up
    // so an admin's `\d+ (` typo is the only thing that ever lands in `rejected`.
    try {
      return { ok: true, value: new RegExp(source, ignoreCase ? "i" : "") };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "Invalid regular expression" };
    }
  }
}

function compileDomain(source: string, ignoreCase: boolean): CompileResult<DomainMatcher> {
  const trimmed = source.trim();

  // A leading dot is how people habitually write "and its subdomains" (cookies, DNS
  // zone files). Test the dot-stripped form, or `.example.com` reads as a regex whose
  // leading `.` matches any character — and quietly stops matching `example.com`.
  // The regex branch still gets the original source, so `.*` stays a regex.
  const bare = trimmed.replace(/^\.+/, "");
  if (BARE_HOSTNAME.test(bare)) {
    return { ok: true, value: { kind: "suffix", host: normaliseHost(bare) } };
  }

  const pattern = compilePattern(trimmed, ignoreCase);
  return pattern.ok ? { ok: true, value: { kind: "regex", pattern: pattern.value } } : pattern;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Classifies one event. Returns {@link UNCATEGORIZED_RESULT} when no rule claims it. */
export function categorizeEvent(set: CompiledRuleSet, event: CategorizableEvent): Categorization {
  const app = bound(event.appName);
  const title = bound(event.windowTitle);
  const domain = bound(event.domain);

  for (const rule of set.rules) {
    if (rule.app && !(app && rule.app.test(app))) continue;
    if (rule.title && !(title && rule.title.test(title))) continue;
    if (rule.domain && !(domain && matchesCompiledDomain(rule.domain, domain))) continue;

    return {
      category: rule.category,
      path: rule.path,
      productivity: rule.productivity,
      ruleId: rule.id,
    };
  }

  return UNCATEGORIZED_RESULT;
}

/** {@link categorizeEvent} against a database row rather than a wire DTO. */
export function categorizeActivityRow(set: CompiledRuleSet, row: ActivityRowLike): Categorization {
  return categorizeEvent(set, {
    appName: row.app_name,
    windowTitle: row.window_title ?? null,
    domain: row.domain ?? null,
  });
}

/**
 * Suffix-aware host matching.
 *
 * `example.com` matches `example.com` and `app.example.com`, and must never match
 * `notexample.com` — plain `endsWith` gets that wrong, and the difference is a
 * lookalike domain inheriting a real site's category.
 *
 * A pattern containing anything other than hostname characters is treated as a
 * regex instead, and an unanchored regex has no suffix guarantee: write
 * `(^|\.)example\.com$` when you need one.
 */
export function matchesDomainPattern(pattern: string, host: string, ignoreCase = true): boolean {
  const matcher = compileDomain(pattern, ignoreCase);
  if (!matcher.ok) return false;
  return matchesCompiledDomain(matcher.value, bound(host) ?? "");
}

function matchesCompiledDomain(matcher: DomainMatcher, rawHost: string): boolean {
  if (matcher.kind === "regex") return matcher.pattern.test(rawHost);

  const host = normaliseHost(rawHost);
  return host === matcher.host || host.endsWith(`.${matcher.host}`);
}

/** Hostnames are case-insensitive; a root dot and a port are not part of identity. */
function normaliseHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
}

function bound(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > MAX_SUBJECT_LENGTH ? value.slice(0, MAX_SUBJECT_LENGTH) : value;
}

function isSet(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Path formatting
// ---------------------------------------------------------------------------

export function formatCategoryPath(path: readonly string[]): string {
  const segments = path.map((s) => s.trim()).filter((s) => s.length > 0);
  return segments.length > 0 ? segments.join(CATEGORY_SEPARATOR) : UNCATEGORIZED;
}

export function parseCategoryPath(category: string | null | undefined): string[] {
  if (!category) return [UNCATEGORIZED];
  const segments = category
    .split(">")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments : [UNCATEGORIZED];
}

// ---------------------------------------------------------------------------
// Catastrophic-backtracking guard
// ---------------------------------------------------------------------------

/**
 * Refuses patterns whose worst case is exponential.
 *
 * JavaScript's engine is backtracking and has no step budget, so `(a+)+$` against
 * forty-odd characters blocks the event loop for minutes — in an ingestion route
 * that is a company-wide outage caused by one typed character in a settings form.
 *
 * The test is deliberately conservative: a repeated group whose body itself repeats
 * or alternates. It rejects some safe patterns (`(?:a|b)+`), which is why every
 * rejection is reported back with a reason rather than swallowed — an admin can see
 * their rule was refused and rewrite it. It is a heuristic, not a proof; the second
 * line of defence is that rule sources are super-admin-only data and subjects are
 * length-bounded.
 */
function patternRisk(source: string): string | null {
  if (source.length > MAX_PATTERN_LENGTH) {
    return `Pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  const openGroups: number[] = [];
  let inClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      openGroups.push(i);
      continue;
    }
    if (ch === ")") {
      const open = openGroups.pop();
      if (open === undefined) continue;
      if (!isUnboundedQuantifierAt(source, i + 1)) continue;

      const body = source.slice(open + 1, i);
      if (hasUnboundedQuantifier(body) || hasAlternation(body)) {
        return "Pattern nests a repetition inside a repetition, which can backtrack catastrophically";
      }
    }
  }

  return null;
}

function isUnboundedQuantifierAt(source: string, at: number): boolean {
  const ch = source[at];
  if (ch === "*" || ch === "+") return true;
  if (ch !== "{") return false;

  const close = source.indexOf("}", at);
  if (close === -1) return false;

  const body = source.slice(at + 1, close);
  const match = /^(\d+)(,(\d*))?$/.exec(body);
  if (!match) return false;

  // `{n}` and `{n,m}` are bounded; treat a large or missing upper bound as unbounded,
  // because `([a-z]{2,}){3,}` explodes exactly like `(a+)+` does.
  if (match[2] === undefined) return Number(match[1]) > LARGE_REPETITION;
  const upper = match[3];
  return upper === undefined || upper === "" || Number(upper) > LARGE_REPETITION;
}

function hasUnboundedQuantifier(body: string): boolean {
  let inClass = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];

    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "*" || ch === "+") return true;
    if (ch === "{" && isUnboundedQuantifierAt(body, i)) return true;
  }

  return false;
}

function hasAlternation(body: string): boolean {
  let inClass = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];

    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "|") return true;
  }

  return false;
}
