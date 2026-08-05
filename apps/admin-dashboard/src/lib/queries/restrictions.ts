/**
 * Website restrictions — the whole client-side domain in one file.
 *
 * Scope note: restriction is **in scope by a client decision taken on 2026-08-05**,
 * recorded in `CLAUDE.md` under "Scope decisions taken after the documents were
 * locked". It overrides `docs/scope.md` §8 for this one feature and nothing else.
 *
 * The mechanism is the managed browser extension that already had to exist for website
 * *tracking* on Windows (open item 6): there is no supported way to read a browser's
 * address bar on Windows, so the extension that reports a URL is the same component
 * that can refuse one. The dashboard writes the rules; the extension enforces them.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  Every type here is the API's, not this screen's invention
 * ───────────────────────────────────────────────────────────────────────────
 *
 * `apps/api/src/routes/restrictions.ts` owns the contract, and it is richer than a
 * list of blocked domains: a rule carries an `action` (so an *allow* rule can punch a
 * hole in a block list), a `matchKind` (a whole host, or a URL pattern with `*`), and
 * a `priority` that decides which rule wins when two match. The settings row carries a
 * master `enabled` switch, the `mode`, and the `notice` employees read on the block
 * page. Modelling any of that as something simpler here would produce a screen that
 * cannot express what the enforcement layer actually does — and the extension, not the
 * dashboard, is what people experience.
 *
 * Two copy rules govern every string below, and they are not decoration:
 *
 *  1. **This is a company policy screen, not a punishment screen.** `docs/design.md`
 *     positions the product as workforce intelligence, and enforcement makes that
 *     framing more fragile rather than less. So: no "violation", no "offender", no
 *     "caught". The refusal list exists so an over-broad rule can be found and fixed —
 *     which is what the copy says it is for.
 *  2. **A refused page must say why and who to ask.** `CLAUDE.md` is explicit that a
 *     bare "blocked" screen is what the design direction rules out. That is what
 *     `notice` (company-wide) and a rule's `note` (per rule) are for, and it is why
 *     this screen treats a rule with no reason as a defect worth flagging rather than
 *     as an empty cell.
 *
 * No `"use client"` directive, on purpose: the query specs below are read by the
 * server component that prefetches them (`settings/restrictions/page.tsx`). The hooks
 * further down are only ever called from client components, which is what makes that
 * safe — the mutation helpers are imported into the server graph but never invoked
 * there.
 */

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch, type EmployeeRow } from "@/lib/api";
import { apiQuery } from "@/lib/query-spec";

// ---------------------------------------------------------------------------
// The contract, mirrored from apps/api/src/routes/restrictions.ts
// ---------------------------------------------------------------------------

/** Which way round the whole policy reads when no rule claims a page. */
export type RestrictionMode = "blocklist" | "allowlist";

/** What one rule does to the pages it claims. */
export type RestrictionAction = "block" | "allow";

/** A whole host (and its subdomains), or a URL pattern with `*`. */
export type RestrictionMatchKind = "domain" | "url_pattern";

/** Company-wide posture. `GET /api/restrictions` returns this under `settings`. */
export interface RestrictionSettings {
  /** The master switch. False means the extension enforces nothing at all. */
  enabled: boolean;
  mode: RestrictionMode;
  /** The sentence employees read on a refused page. Null when nobody wrote one. */
  notice: string | null;
  /** Bumped on every change; the agent polls it to know when to reload. */
  revision: number;
  updatedAt: string | null;
}

export interface RestrictionRule {
  id: string;
  /** Lower runs first. The first rule that matches decides. */
  priority: number;
  action: RestrictionAction;
  matchKind: RestrictionMatchKind;
  pattern: string;
  /** The reason shown for *this* rule, on top of the company-wide notice. */
  note: string | null;
  /** A parked rule is kept but never evaluated. */
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A rule the matcher refused to compile.
 *
 * The API computes this on read rather than making the screen guess, and surfacing it
 * is the whole point: a rule that silently never fires is an admin believing a typo is
 * protecting them.
 */
export interface RejectedRestrictionRule {
  ruleId: string;
  pattern: string;
  reason: string;
}

/** The body of `GET /api/restrictions`. */
export interface RestrictionPolicy {
  settings: RestrictionSettings;
  rules: RestrictionRule[];
  rejected: RejectedRestrictionRule[];
}

/** One request the extension refused, as `GET /api/restrictions/events` returns it. */
export interface RestrictionEvent {
  /**
   * A **number**, not a uuid — `website_block_events.id` is a bigint and the API passes
   * it through unchanged. Verified against a live response; typing it as a string would
   * compile and then quietly break any comparison made against it.
   */
  id: number;
  profileId: string | null;
  deviceId: string | null;
  /** Null when the company's *mode* refused it rather than a rule — see `refusalReason`. */
  ruleId: string | null;
  matchedPattern: string | null;
  mode: RestrictionMode;
  domain: string | null;
  url: string | null;
  blockedAt: string;
}

/** The body `PUT /api/restrictions/settings` takes. All three, every time. */
export interface RestrictionSettingsInput {
  enabled: boolean;
  mode: RestrictionMode;
  notice: string | null;
}

/** `POST /api/restrictions/rules` takes this; `PATCH .../:id` takes it partially. */
export interface RestrictionRuleInput {
  action: RestrictionAction;
  matchKind: RestrictionMatchKind;
  pattern: string;
  priority: number;
  note: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Bounds — the API's, restated so a refusal is explained before it is sent
// ---------------------------------------------------------------------------

/** `note` column bound. The API refuses a longer one with a 400. */
export const MAX_NOTE_LENGTH = 300;
/** `pattern` column check. */
export const MAX_PATTERN_LENGTH = 400;
/** Past this the API answers 409 `rule_limit_reached`. */
export const MAX_RULES_PER_COMPANY = 500;
/** The API's `priority` default, and the one every rule gets unless it is reordered. */
export const DEFAULT_RULE_PRIORITY = 100;

// ---------------------------------------------------------------------------
// Query specs
// ---------------------------------------------------------------------------

export const restrictionPolicyQuery = apiQuery<RestrictionPolicy>({
  queryKey: ["restrictions", "policy"],
  path: "/api/restrictions",
  staleTime: 60_000,
});

/**
 * Refusals, newest first.
 *
 * `limit` is in the path rather than in a variable so the key is a constant and the
 * server can warm it. A date-range picker would key on the reader's clock, which
 * `server-query.tsx` rule 2 says cannot be prefetched — so the window is "the last
 * `limit` refusals", which needs no clock on either side.
 */
export const restrictionEventsQuery = apiQuery<RestrictionEvent[]>({
  queryKey: ["restrictions", "events"],
  path: "/api/restrictions/events?limit=100",
  staleTime: 30_000,
});

/** The number asked for above, so the screen can say when it is showing a full page. */
export const RESTRICTION_EVENT_LIMIT = 100;

/**
 * The roster, so a refusal can name a person instead of printing a UUID.
 *
 * Same key and path as `useEmployees()` in `lib/api.ts` and as `settings-specs.ts`,
 * deliberately: TanStack keys are global, so warming `["employees"]` here means the
 * Company tab reads it from cache too. `/settings/**` is super-admin only, so nobody
 * reaches this page without already being entitled to `/api/employees`.
 */
export const restrictionPeopleQuery = apiQuery<EmployeeRow[]>({
  queryKey: ["employees"],
  path: "/api/employees",
});

export const RESTRICTION_QUERIES = [
  restrictionPolicyQuery,
  restrictionEventsQuery,
  restrictionPeopleQuery,
] as const;

// ---------------------------------------------------------------------------
// Patterns — pure, and the only place a rule's text is judged before the server
// ---------------------------------------------------------------------------

/**
 * A hostname reduced to the form the API stores for a `domain` rule.
 *
 * Mirrors `canonicalDomainPattern` in `apps/api/src/routes/restrictions.ts`. People
 * paste URLs: `https://www.facebook.com/groups/123`, `FACEBOOK.COM`, a trailing slash,
 * a port. Every one of those means the same rule, and refusing them teaches nothing —
 * so the input is reduced rather than rejected, and the reduction is shown as it is
 * typed so nobody is surprised by what got saved.
 *
 * Returns null when what is left cannot be a host. **The server is still the
 * authority**: this exists so the common mistakes are explained in the form, not so
 * the client can pre-empt the matcher.
 */
export function canonicalDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value === "") return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");

  const slash = value.indexOf("/");
  if (slash !== -1) value = value.slice(0, slash);

  // `user:pass@host` — credentials are not part of the host, and a matcher that
  // thought they were would read `https://evil.com@example.com/` as evil.com.
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);

  value = stripPort(value);
  value = value.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (value === "" || value.includes("*")) return null;

  return asciiHost(value) === null ? null : value;
}

function stripPort(value: string): string {
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value : value.slice(0, close + 1);
  }
  return value.replace(/:\d*$/, "");
}

/**
 * The host as a browser would request it, or null if it is not a host at all.
 *
 * `URL` does the work for the same reason the API lets it: it is the only parser in
 * either runtime that agrees with what the browser will actually send, punycode
 * included. Available in Node, in the Next server render, and in every browser.
 */
function asciiHost(host: string): string | null {
  if (host.startsWith("[")) return host.endsWith("]") ? host : null;

  try {
    const parsed = new URL(`https://${host}`).hostname.toLowerCase().replace(/\.+$/, "");
    return parsed === "" ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Why this pattern cannot be used, in words that say what to do instead.
 *
 * Deliberately narrow. It refuses only what the API certainly refuses and what a
 * person can certainly fix; everything subtler is left to the server, whose own
 * sentence the dialog renders. A client validator that guesses at the matcher's rules
 * ends up refusing patterns the server would have taken, which is worse than a round
 * trip.
 */
export function patternProblem(kind: RestrictionMatchKind, raw: string): string | null {
  const value = raw.trim();
  if (value === "") {
    return kind === "domain"
      ? "Enter a website, for example facebook.com."
      : "Enter a URL pattern, for example example.com/admin*.";
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    return `That is longer than ${String(MAX_PATTERN_LENGTH)} characters, which is more than any real address.`;
  }
  if (/\s/.test(value)) {
    return "A rule covers one address. Add the others as their own rules.";
  }

  // A URL pattern is compiled by the matcher, and the matcher is the authority on
  // whether one is usable. Guessing at its rules here would refuse patterns the server
  // would have taken, which is worse than a round trip.
  if (kind === "url_pattern") return null;

  if (canonicalDomain(value) !== null) return null;

  if (value.includes("*")) {
    return "A website rule covers subdomains already. Switch to a URL pattern if you need a wildcard.";
  }

  return "That is not a website address. Enter the domain on its own, like github.com.";
}

/**
 * A pattern that is legal but almost certainly not what was meant.
 *
 * Separate from {@link patternProblem} on purpose. The API accepts a single-label host —
 * `intranet` is a real hostname on a corporate LAN — so refusing it here would refuse
 * something the server takes, which this file is careful never to do. But `facebook`
 * typed in place of `facebook.com` compiles cleanly, matches nothing an employee will
 * ever visit, and is indistinguishable from a working rule in the table. That deserves a
 * sentence, not a refusal.
 *
 * Returns null when there is nothing to caution about.
 */
export function patternCaution(kind: RestrictionMatchKind, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  const host = kind === "domain" ? canonicalDomain(value) : value.split(/[/?#]/)[0];
  if (!host || host.includes("*") || host.includes(".")) return null;

  return `“${host}” is a single-word host, so this matches ${host} and its subdomains but never ${host}.com. That is right for an internal site and a typo for anything else.`;
}

/** How far a rule reaches, spelled out — the sentence under the pattern in the table. */
export function ruleReach(rule: Pick<RestrictionRule, "matchKind" | "pattern">): string {
  if (rule.matchKind === "domain") {
    const host = canonicalDomain(rule.pattern) ?? rule.pattern;
    return `${host} and every subdomain of it`;
  }

  return `URLs matching ${rule.pattern}`;
}

export const MATCH_KIND_LABEL: Record<RestrictionMatchKind, string> = {
  domain: "Whole website",
  url_pattern: "URL pattern",
};

/** What one rule does, said from the employee's side rather than the rule's. */
export function actionEffect(action: RestrictionAction): string {
  return action === "block" ? "Blocked" : "Allowed";
}

// ---------------------------------------------------------------------------
// Mode and the master switch
// ---------------------------------------------------------------------------

export interface ModeCopy {
  label: string;
  /** What the mode does, in one sentence. */
  summary: string;
  /** Heading for the rule table under this mode. */
  listHeading: string;
  /** What the table is for, under this mode. */
  listDescription: string;
}

export function modeCopy(mode: RestrictionMode): ModeCopy {
  if (mode === "allowlist") {
    return {
      label: "Allow list",
      summary:
        "Only the websites these rules allow can be opened on company devices. Everything else is refused.",
      listHeading: "Website rules",
      listDescription:
        "Anything no rule allows is refused, so everything employees need for their work has to be listed before this policy is relied on. A block rule narrows an allow rule that is broader than intended.",
    };
  }

  return {
    label: "Block list",
    summary:
      "Every website can be opened on company devices except the ones these rules block.",
    listHeading: "Website rules",
    listDescription:
      "Everything not named here stays available. An allow rule makes an exception to a block rule that is broader than intended — the lower order number wins.",
  };
}

/**
 * What a settings change does, said before it is done.
 *
 * The asymmetry is the point. Turning a block list into an allow list takes a device
 * from "almost everything works" to "almost nothing works" in one click, and the sites
 * that break are the ones nobody thought to list — payroll, a bank, a supplier portal.
 * That is worth a sentence and a confirmation; the reverse is not.
 */
export function settingsChangeConsequence(
  next: Pick<RestrictionSettings, "enabled" | "mode">,
  current: Pick<RestrictionSettings, "enabled" | "mode">,
  ruleCount: number,
): string | null {
  const listed = ruleCount === 1 ? "1 rule is written" : `${String(ruleCount)} rules are written`;

  if (!next.enabled && current.enabled) {
    return `Every website starts opening again on company devices, on each device's next policy refresh. The rules are kept and take effect again whenever enforcement is switched back on.`;
  }

  // Enforcement is off and staying off. Whatever else moved — the mode, the message —
  // no browser behaves differently, so there is nothing to warn about. Without this the
  // mode branch below would announce a change to devices that are not being filtered.
  if (!next.enabled) return null;

  if (next.enabled && next.mode === "allowlist" && !(current.enabled && current.mode === "allowlist")) {
    return `Every website except the ones these rules allow stops opening on company devices, on each device's next policy refresh. ${listed}. Anything employees need for their work — payroll, banking, a supplier portal — has to be allowed before it stops working.`;
  }

  if (next.enabled && !current.enabled) {
    return `The rules below start being enforced on company devices, on each device's next policy refresh. ${listed}.`;
  }

  if (next.mode !== current.mode) {
    return `Every website starts opening again except the ones these rules block, on each device's next policy refresh. ${listed}.`;
  }

  // Nothing consequential changed — the notice was edited, or nothing was.
  return null;
}

/**
 * When a change reaches a browser.
 *
 * Stated rather than implied, for the same reason `POLICY_ROLLOUT_NOTE` exists: a
 * screen that lets someone save a rule and walk away believing it is live, when the
 * extension has not refreshed yet, is the least reliable statement in a compliance
 * product.
 */
export const RESTRICTION_ROLLOUT_NOTE =
  "Rules reach a device the next time its browser extension refreshes the policy. Pages already open are not closed.";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export interface DomainTally {
  domain: string;
  count: number;
  /** People affected, not requests — one person reloading twenty times is one person. */
  people: number;
}

/**
 * The domains refused most often, busiest first.
 *
 * This is the diagnostic the screen exists for. A domain at the top of that tally with
 * no rule behind it under an allow list is a site the company needs and has not
 * allowed; a domain at the top under a block list is usually a rule broader than
 * whoever wrote it intended. Either way the answer is to change a rule, which is why
 * the tally sits next to the rules rather than being presented as a report about
 * people.
 */
export function domainTallies(events: readonly RestrictionEvent[], limit = 5): DomainTally[] {
  const byDomain = new Map<string, { count: number; people: Set<string> }>();

  for (const event of events) {
    const domain = event.domain ?? "(unreadable address)";
    const entry = byDomain.get(domain) ?? { count: 0, people: new Set<string>() };
    entry.count += 1;
    if (event.profileId) entry.people.add(event.profileId);
    byDomain.set(domain, entry);
  }

  return [...byDomain.entries()]
    .map(([domain, entry]) => ({ domain, count: entry.count, people: entry.people.size }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, Math.max(0, limit));
}

/**
 * Why one request was refused — the rule, or the absence of one.
 *
 * "No rule allows it" is not a failure state. Under an allow list it is the *normal*
 * reason, and naming it that way is what turns the row into something an admin can act
 * on rather than something an employee has to explain.
 */
export function refusalReason(
  event: Pick<RestrictionEvent, "mode" | "ruleId" | "matchedPattern">,
  byId: ReadonlyMap<string, RestrictionRule>,
): string {
  if (event.ruleId) {
    const rule = byId.get(event.ruleId);
    if (rule) return `Rule: ${rule.pattern}`;
    // `website_block_events.rule_id` is `on delete set null`, so a populated id whose
    // rule is gone cannot normally happen — but the pattern was copied onto the event
    // precisely so the record survives the rule, and printing it beats printing a UUID.
    return event.matchedPattern
      ? `Rule since removed: ${event.matchedPattern}`
      : "A rule that has since been removed";
  }

  return event.mode === "allowlist" ? "No rule allows it" : "No rule — the policy has changed since";
}

/** `id -> rule`, for joining a refusal back to the rule that caused it. */
export function rulesById(rules: readonly RestrictionRule[]): Map<string, RestrictionRule> {
  return new Map(rules.map((rule) => [rule.id, rule]));
}

/** `ruleId -> why the matcher refused to compile it`. */
export function rejectionsById(
  rejected: readonly RejectedRestrictionRule[],
): Map<string, RejectedRestrictionRule> {
  return new Map(rejected.map((entry) => [entry.ruleId, entry]));
}

/**
 * The person a refusal belongs to, named.
 *
 * A UUID in this column would make the row useless: "is this stopping someone doing
 * their job" is the question being asked, and it cannot be answered without a name.
 * Falls back to null rather than to the id — an unrecognised profile is honestly
 * unknown, and printing 36 hex characters is not more honest, only less readable.
 */
export function personLabel(
  profileId: string | null,
  people: readonly EmployeeRow[],
): string | null {
  if (!profileId) return null;
  const person = people.find((row) => row.id === profileId);
  if (!person) return null;
  return person.full_name || person.email;
}

// ---------------------------------------------------------------------------
// Forms — React Hook Form + Zod, per CLAUDE.md
// ---------------------------------------------------------------------------

/**
 * The single source of validation truth for a rule.
 *
 * Every bound here is one the API enforces as well; the schema exists so a refusal is
 * explained in the form rather than arriving as a 400 the reader has to interpret.
 * Where the two ever disagree the server wins, and the server's own words are what the
 * dialog shows — `describeError` keeps a 400's message for exactly that.
 */
export const restrictionRuleSchema = z
  .object({
    matchKind: z.enum(["domain", "url_pattern"]),
    action: z.enum(["block", "allow"]),
    pattern: z.string().max(2048, "That is far too long to be a web address."),
    priority: z
      .number({ invalid_type_error: "Order must be a number." })
      .int("Order must be a whole number.")
      .min(0, "Order cannot be negative.")
      .max(100_000, "Order must be 100000 or less."),
    note: z.string().max(MAX_NOTE_LENGTH, `Keep the reason under ${String(MAX_NOTE_LENGTH)} characters.`),
    enabled: z.boolean(),
  })
  .superRefine((values, ctx) => {
    const problem = patternProblem(values.matchKind, values.pattern);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pattern"], message: problem });
    }
  });

export type RestrictionRuleForm = z.infer<typeof restrictionRuleSchema>;

/**
 * A new rule's starting point.
 *
 * `matchKind: "domain"` because that is what people mean, and because a domain rule
 * covers the mobile and app hosts of the same site — a rule that missed
 * `m.facebook.com` is a rule that looks broken. The default `action` follows the mode
 * the company is in, which is why it is a parameter rather than a constant.
 */
export function emptyRestrictionRule(mode: RestrictionMode): RestrictionRuleForm {
  return {
    matchKind: "domain",
    action: mode === "allowlist" ? "allow" : "block",
    pattern: "",
    priority: DEFAULT_RULE_PRIORITY,
    note: "",
    enabled: true,
  };
}

export function restrictionRuleFormFrom(rule: RestrictionRule): RestrictionRuleForm {
  return {
    matchKind: rule.matchKind,
    action: rule.action,
    pattern: rule.pattern,
    priority: rule.priority,
    note: rule.note ?? "",
    enabled: rule.enabled,
  };
}

/**
 * The form's values as the API takes them.
 *
 * The note is trimmed and an empty one becomes `null`, which is not cosmetic: the API's
 * `note` is `min(1).nullish()`, so sending `""` is a 400 for a field the person left
 * deliberately blank.
 */
export function restrictionRuleToInput(form: RestrictionRuleForm): RestrictionRuleInput {
  const note = form.note.trim();

  return {
    action: form.action,
    matchKind: form.matchKind,
    // A domain rule is stored canonicalised by the server; sending the canonical form
    // means the confirmation the screen shows is the text that was actually saved.
    pattern:
      form.matchKind === "domain"
        ? (canonicalDomain(form.pattern) ?? form.pattern.trim().toLowerCase())
        : form.pattern.trim(),
    priority: form.priority,
    note: note === "" ? null : note,
    enabled: form.enabled,
  };
}

/**
 * A rule with the same pattern that already exists.
 *
 * The API answers 409 `rule_exists` for this, and the 409 is the authority — but it
 * arrives after a round trip and cannot name the clashing rule's *reason*, which is the
 * thing the person actually needs in order to decide whether to edit it instead.
 */
export function duplicateRule(
  rules: readonly RestrictionRule[],
  form: Pick<RestrictionRuleForm, "matchKind" | "pattern">,
  ignoreId: string | null,
): RestrictionRule | null {
  const wanted =
    form.matchKind === "domain"
      ? canonicalDomain(form.pattern)
      : form.pattern.trim().toLowerCase();
  if (wanted === null || wanted === "") return null;

  return (
    rules.find(
      (rule) =>
        rule.id !== ignoreId &&
        rule.matchKind === form.matchKind &&
        (rule.matchKind === "domain"
          ? canonicalDomain(rule.pattern) === wanted
          : rule.pattern.trim().toLowerCase() === wanted),
    ) ?? null
  );
}

/** The company-wide posture form: the master switch, the mode, and the block-page notice. */
export const restrictionSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["blocklist", "allowlist"]),
  // Optional on purpose — but the screen says out loud what an empty one costs, because
  // a refused page with no message is exactly what `CLAUDE.md` rules out.
  notice: z.string().max(500, "Keep the message under 500 characters."),
});

export type RestrictionSettingsForm = z.infer<typeof restrictionSettingsSchema>;

export function restrictionSettingsFormFrom(
  settings: RestrictionSettings,
): RestrictionSettingsForm {
  return { enabled: settings.enabled, mode: settings.mode, notice: settings.notice ?? "" };
}

export function restrictionSettingsToInput(
  form: RestrictionSettingsForm,
): RestrictionSettingsInput {
  const notice = form.notice.trim();
  // Same reason as a rule's note: the API's `notice` is `min(1).nullish()`, so a blank
  // box has to be sent as `null` rather than as an empty string.
  return { enabled: form.enabled, mode: form.mode, notice: notice === "" ? null : notice };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Everything a rule or settings change invalidates.
 *
 * Both keys, always. The refusal list is a function of the rules — a domain that stops
 * being blocked stops appearing — so leaving `["restrictions", "events"]` behind would
 * show an admin the consequences of a policy that is no longer in force.
 */
function invalidateRestrictions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["restrictions"] });
}

/**
 * Saves the company-wide posture.
 *
 * Not optimistic, for the same reason the monitoring toggle is not: the control states
 * whether people can reach the internet from a company device, and showing the new
 * posture before the server has agreed is the one lie this screen cannot tell.
 */
export function useSaveRestrictionSettings() {
  const queryClient = useQueryClient();

  return useMutation<RestrictionSettings, unknown, RestrictionSettingsInput>({
    mutationFn: (input) =>
      apiFetch<RestrictionSettings>("/api/restrictions/settings", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: (settings) => {
      // Written straight into the cached policy so the screen reflects the server's own
      // row — including the `revision` it minted — without waiting for the refetch.
      queryClient.setQueryData<RestrictionPolicy>(restrictionPolicyQuery.queryKey, (current) =>
        current ? { ...current, settings } : current,
      );
      invalidateRestrictions(queryClient);
    },
    retry: false,
  });
}

export function useCreateRestrictionRule() {
  const queryClient = useQueryClient();

  return useMutation<RestrictionRule, unknown, RestrictionRuleInput>({
    mutationFn: (input) =>
      apiFetch<RestrictionRule>("/api/restrictions/rules", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateRestrictions(queryClient),
    retry: false,
  });
}

export interface RestrictionRuleEdit {
  id: string;
  input: Partial<RestrictionRuleInput>;
}

export function useUpdateRestrictionRule() {
  const queryClient = useQueryClient();

  return useMutation<RestrictionRule, unknown, RestrictionRuleEdit>({
    mutationFn: ({ id, input }) =>
      apiFetch<RestrictionRule>(`/api/restrictions/rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidateRestrictions(queryClient),
    retry: false,
  });
}

export interface RestrictionRuleDeleted {
  deleted: true;
  id: string;
}

export function useDeleteRestrictionRule() {
  const queryClient = useQueryClient();

  return useMutation<RestrictionRuleDeleted, unknown, string>({
    mutationFn: (id) =>
      apiFetch<RestrictionRuleDeleted>(`/api/restrictions/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateRestrictions(queryClient),
    retry: false,
  });
}
