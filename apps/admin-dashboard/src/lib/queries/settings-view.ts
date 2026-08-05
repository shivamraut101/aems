import {
  CATEGORY_SEPARATOR,
  compileRules,
  type Productivity,
  type RejectedRule,
} from "@aems/analytics";
import { z } from "zod";

import { ApiError } from "@/lib/api";

// Re-exported so the settings components have one import for the whole screen and
// never reach past this module into the engine.
export type { Productivity, RejectedRule };

/**
 * View models for /settings.
 *
 * The compliance-critical copy lives here rather than inline in JSX so it can be
 * asserted: a monitoring toggle whose wording does not state what stops, what is
 * kept and when it takes effect is a defect, not a styling choice.
 *
 * The same reasoning applies to validation. Every draft on this screen is checked
 * here, by pure functions, against the *same* rules the API enforces — and in the
 * case of a category rule, against the *same compiler*, imported from
 * `@aems/analytics`. A form that lets you save something the server will refuse is
 * a form that reports the refusal as a mystery.
 */

/** `policies` as the table stores it — snake_case, straight from the row. */
export interface PolicyRecord {
  id: string;
  company_id: string;
  version: string;
  name: string;
  screenshot_interval_seconds: number;
  idle_threshold_seconds: number;
  tracked_categories: string[];
  created_at: string;
  updated_at: string;
}

/** The five intervals `docs/scope.md` §2.3 names. Not a free-text number. */
export const SCREENSHOT_INTERVAL_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 1800, label: "30 min" },
];

/**
 * A duration in the words a policy uses.
 *
 * Separate from `lib/format.ts`'s `duration()`, which renders worked time ("7h 20m")
 * and drops seconds. A 30-second idle threshold is a legal value here, and rounding
 * it away would show two different policies as the same policy.
 */
export function intervalLabel(seconds: number): string {
  if (seconds <= 0) return "—";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (rest > 0) parts.push(`${rest} sec`);

  return parts.join(" ");
}

/** Captures over an eight-hour day — the number that makes an interval concrete. */
export function screenshotsPerDay(intervalSeconds: number): number {
  if (intervalSeconds <= 0) return 0;
  return Math.floor((8 * 3600) / intervalSeconds);
}

export type PolicyState = "loading" | "ready" | "missing" | "forbidden" | "error";

/**
 * Which of five things the policy panel is looking at.
 *
 * `missing` exists so that a company which has simply not published a policy yet —
 * every company, on day one — is told to publish one instead of being shown a red
 * failure box. That distinction is the difference between an empty product and a
 * broken one, and a demo starts empty.
 */
export function policyState(query: {
  isLoading: boolean;
  error: unknown;
  data: PolicyRecord | null | undefined;
}): PolicyState {
  if (query.isLoading) return "loading";

  if (query.error) {
    if (query.error instanceof ApiError) {
      if (query.error.status === 404) return "missing";
      if (query.error.status === 403) return "forbidden";
    }
    return "error";
  }

  return query.data ? "ready" : "missing";
}

export interface MonitoringCopy {
  action: string;
  detail: string;
}

/**
 * What the per-employee monitoring toggle promises.
 *
 * Three obligations are written into these two sentences. Non-negotiable #4 —
 * revocation takes effect on the agent's next request, not "eventually". Data
 * already collected is retained, because a toggle is not a delete. And resuming
 * still runs through consent, because `monitoring_enabled` is a company control and
 * consent is the employee's — turning collection back on does not re-consent for
 * them.
 */
export function monitoringConsequence(enabled: boolean): MonitoringCopy {
  if (enabled) {
    return {
      action: "Pause monitoring",
      detail:
        "The agent stops collecting activity, screenshots and app usage on its next check-in. Data already recorded is kept and stays visible in reports.",
    };
  }

  return {
    action: "Resume monitoring",
    detail:
      "Collection restarts on the next check-in, provided this person's consent for the device is still in force. Nothing from the paused period is recovered.",
  };
}

/**
 * What to say once the server has confirmed the change.
 *
 * The badge flipping is not feedback — it is indistinguishable from a stale render,
 * and on a control this consequential "did that work?" is a question the screen has
 * to answer out loud. Non-negotiable #4 is restated here rather than only in the
 * confirmation, because the sentence a person reads *after* acting is the one they
 * remember.
 */
export function monitoringChangeConfirmation(name: string, enabled: boolean): string {
  return enabled
    ? `Monitoring resumed for ${name}. Their agent starts collecting again at its next check-in, if consent for the device is still in force.`
    : `Monitoring paused for ${name}. Their agent stops collecting at its next check-in. Everything already recorded is kept.`;
}

// ---------------------------------------------------------------------------
// Publishing a policy
// ---------------------------------------------------------------------------

/**
 * `POST /api/policies`, as the body is sent — mirroring `policyDraftSchema` in
 * `apps/api/src/routes/policies.ts`.
 *
 * camelCase because that is what the API speaks on the way in, while the row it
 * returns is snake_case (see {@link PolicyRecord}).
 *
 * `version` is optional on purpose. The server mints the next label in its own
 * `YYYY.MM.N` series, and an admin publishing a policy should be choosing a
 * screenshot interval, not inventing a version string. It is sent only when someone
 * deliberately overrides it.
 */
export interface PolicyPublishInput {
  version?: string;
  name: string;
  screenshotIntervalSeconds: number;
  idleThresholdSeconds: number;
  trackedCategories: string[];
}

/**
 * The form's own state — strings where the control holds a string.
 *
 * Kept separate from {@link PolicyPublishInput} so "" and 0 stay distinguishable:
 * a blank version field means "let the server choose", which is not the same
 * statement as any particular version.
 */
export interface PolicyDraft {
  /** Blank means the server assigns the next version in its series. */
  version: string;
  name: string;
  screenshotIntervalSeconds: number;
  idleThresholdSeconds: number;
  /** Comma-separated. Empty means "record everything", which is the common case. */
  trackedCategories: string;
}

/**
 * The API's own constraint on a hand-picked version label, character for character
 * (`policies.ts` `policyDraftSchema`). It is quoted back in consent records and
 * audit metadata, which is why it is not free text.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `name` and `trackedCategories` bounds, matching the API's zod schema exactly. */
const MAX_NAME_LENGTH = 160;
const MAX_VERSION_LENGTH = 40;
const MAX_TRACKED_CATEGORIES = 50;
const MAX_CATEGORY_LENGTH = 60;

/**
 * Idle thresholds worth offering.
 *
 * `docs/scope.md` §2.3 fixes the five screenshot intervals but says nothing about
 * idle, so this list is a convenience rather than a contract — hence
 * {@link intervalOptionsWith}, which keeps whatever value a company already runs.
 */
export const IDLE_THRESHOLD_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: "1 min" },
  { seconds: 120, label: "2 min" },
  { seconds: 180, label: "3 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 900, label: "15 min" },
];

/**
 * The offered options, plus the value currently in force if it is not one of them.
 *
 * Without this, opening the publish form on a company running a 45-second threshold
 * would silently reset it to whichever option happened to be first — an edit nobody
 * asked for, applied by a `<select>`.
 */
export function intervalOptionsWith(
  options: readonly { seconds: number; label: string }[],
  seconds: number,
): { seconds: number; label: string }[] {
  if (seconds <= 0 || options.some((option) => option.seconds === seconds)) return [...options];
  return [...options, { seconds, label: intervalLabel(seconds) }].sort(
    (a, b) => a.seconds - b.seconds,
  );
}

/**
 * The screenshot intervals the select offers.
 *
 * The API accepts **only** the five `docs/scope.md` §2.3 names — the column check is
 * merely `>= 30`, so the schema is the narrower authority and this list has to agree
 * with it. A company already running something else (hand-written SQL, an older
 * migration) still sees its real value here, flagged, rather than having it silently
 * rewritten to whichever option happened to be first.
 */
export function screenshotIntervalChoices(
  current: number,
): { seconds: number; label: string; standard: boolean }[] {
  const standard = SCREENSHOT_INTERVAL_OPTIONS.map((option) => ({ ...option, standard: true }));
  if (current <= 0 || standard.some((option) => option.seconds === current)) return standard;

  return [
    ...standard,
    {
      seconds: current,
      label: `${intervalLabel(current)} — not a standard interval`,
      standard: false,
    },
  ].sort((a, b) => a.seconds - b.seconds);
}

/**
 * Seeds the publish form from the policy in force, so publishing edits rather than
 * retypes.
 *
 * The version is deliberately left blank: the server mints the next label in its own
 * `YYYY.MM.N` series, and a dashboard that guessed at one would either collide with a
 * version consent is already recorded against or invent a second numbering scheme
 * alongside the server's.
 */
export function policyDraftFrom(current: PolicyRecord | null | undefined): PolicyDraft {
  return {
    version: "",
    name: current?.name ?? "Standard monitoring policy",
    screenshotIntervalSeconds: current?.screenshot_interval_seconds ?? 300,
    idleThresholdSeconds: current?.idle_threshold_seconds ?? 300,
    trackedCategories: (current?.tracked_categories ?? []).join(", "),
  };
}

/** Splits the comma-separated field, dropping blanks and duplicates but keeping order. */
export function parseTrackedCategories(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of text.split(",")) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

export type PolicyDraftErrors = Partial<Record<keyof PolicyDraft, string>>;

/**
 * Refuses a draft the API would refuse, and one it would not.
 *
 * Every bound here is copied from `policyDraftSchema` rather than approximated,
 * because an approximation means the form accepts something the server rejects and
 * the admin is handed a zod error string to interpret.
 *
 * The extra refusal is the duplicate version: policies are append-only history, and
 * two rows sharing a version number makes "which policy was in force when this
 * screenshot was taken" unanswerable. `existingVersions` is what the screen knows —
 * today that is the one policy in force, which catches the mistake people actually
 * make. The server checks the whole series and answers 409, so this is a courtesy,
 * not the boundary.
 */
export function validatePolicyDraft(
  draft: PolicyDraft,
  existingVersions: readonly string[] = [],
): PolicyDraftErrors {
  const errors: PolicyDraftErrors = {};

  // Blank is valid and is the default: the server mints the next version.
  const version = draft.version.trim();
  if (version) {
    if (version.length > MAX_VERSION_LENGTH) {
      errors.version = `Keep the version under ${MAX_VERSION_LENGTH} characters.`;
    } else if (!VERSION_PATTERN.test(version)) {
      errors.version =
        "A version may contain letters, digits, dots, dashes and underscores, and must start with a letter or digit.";
    } else if (existingVersions.some((existing) => existing.trim() === version)) {
      errors.version = `Version ${version} already exists. Publishing appends a version, so this one needs a new label.`;
    }
  }

  const name = draft.name.trim();
  if (!name) {
    errors.name = "Name the policy, so an employee reading it knows what they agreed to.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  }

  if (!SCREENSHOT_INTERVAL_OPTIONS.some((o) => o.seconds === draft.screenshotIntervalSeconds)) {
    errors.screenshotIntervalSeconds = `Choose one of the five standard intervals: ${SCREENSHOT_INTERVAL_OPTIONS.map((o) => o.label).join(", ")}.`;
  }

  if (!isPositiveInteger(draft.idleThresholdSeconds)) {
    errors.idleThresholdSeconds = "Choose an idle threshold.";
  } else if (draft.idleThresholdSeconds < 30 || draft.idleThresholdSeconds > 3600) {
    errors.idleThresholdSeconds = "The threshold must be between 30 seconds and 1 hour.";
  }

  const categories = parseTrackedCategories(draft.trackedCategories);
  if (categories.length > MAX_TRACKED_CATEGORIES) {
    errors.trackedCategories = `${MAX_TRACKED_CATEGORIES} categories is the limit for one policy.`;
  } else if (categories.some((category) => category.length > MAX_CATEGORY_LENGTH)) {
    errors.trackedCategories = `Each category must be under ${MAX_CATEGORY_LENGTH} characters.`;
  }

  return errors;
}

/**
 * {@link validatePolicyDraft} as the resolver React Hook Form takes.
 *
 * A factory rather than a constant because the duplicate-version check needs to know
 * which versions already exist, and that is data rather than schema. `CLAUDE.md` makes
 * the Zod schema the single source of validation truth for every form — this keeps
 * that true without forking the rules into a second place: the schema *is* the
 * validator, wrapped, so the 40-odd assertions already written against
 * `validatePolicyDraft` go on covering the form.
 */
export function policyFormSchema(existingVersions: readonly string[] = []) {
  return z
    .object({
      version: z.string(),
      name: z.string(),
      screenshotIntervalSeconds: z.number(),
      idleThresholdSeconds: z.number(),
      trackedCategories: z.string(),
    })
    .superRefine((draft, ctx) => {
      for (const [field, message] of Object.entries(validatePolicyDraft(draft, existingVersions))) {
        if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
      }
    });
}

/** Omits `version` when the field is blank, which is how the server is asked to mint one. */
export function policyDraftToInput(draft: PolicyDraft): PolicyPublishInput {
  const version = draft.version.trim();

  return {
    ...(version ? { version } : {}),
    name: draft.name.trim(),
    screenshotIntervalSeconds: draft.screenshotIntervalSeconds,
    idleThresholdSeconds: draft.idleThresholdSeconds,
    trackedCategories: parseTrackedCategories(draft.trackedCategories),
  };
}

/**
 * When a published policy actually reaches an agent.
 *
 * Says "enrolled after" rather than "at the next check-in" because that is what the
 * API does: `POST /api/devices/enroll` hands the newest policy to a device once, and
 * `POST /api/devices/heartbeat` answers `{ ok: true }` and nothing else. Claiming a
 * live rollout the server does not perform would make this panel the least reliable
 * statement in a compliance product. See the reported gap.
 */
export const POLICY_ROLLOUT_NOTE =
  "A published version is handed to every device that enrols after it. Devices already enrolled keep the interval they were given until they enrol again — the heartbeat does not carry a policy today.";

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------

/** `GET /api/activity/categories`, one rule, exactly as the API's `toDto` emits it. */
export interface CategoryRuleDto {
  id: string;
  path: string[];
  productivity: Productivity;
  priority: number;
  matchApp: string | null;
  matchDomain: string | null;
  matchTitle: string | null;
  ignoreCase: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The whole response.
 *
 * `rejected` is the reason this screen exists. The ingestion path skips a rule it
 * cannot compile rather than failing the batch, so a bad regex is invisible
 * everywhere else in the product — activity simply stops being classified and
 * nothing says why. The API returns the refusals specifically so a settings screen
 * can surface and repair them.
 */
export interface CategoryRulesResponse {
  rules: CategoryRuleDto[];
  rejected: RejectedRule[];
}

/** The body `POST /api/activity/categories` and `PATCH .../:id` accept. */
export interface CategoryRuleInput {
  path: string[];
  productivity: Productivity;
  priority: number;
  matchApp: string | null;
  matchDomain: string | null;
  matchTitle: string | null;
  ignoreCase: boolean;
}

export const PRODUCTIVITY_OPTIONS: readonly { value: Productivity; label: string }[] = [
  { value: "productive", label: "Productive" },
  { value: "neutral", label: "Neutral" },
  { value: "unproductive", label: "Unproductive" },
];

export function productivityLabel(value: Productivity): string {
  return PRODUCTIVITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/**
 * The badge each classification wears.
 *
 * Reuses the presence variants rather than inventing a fourth palette — emerald,
 * zinc and red already mean "good / neutral / attention" everywhere else in the
 * product, and `docs/design.md` reserves indigo for AI output, which a rule an
 * admin typed is not.
 */
export function productivityBadgeVariant(value: Productivity): "online" | "offline" | "revoked" {
  switch (value) {
    case "productive":
      return "online";
    case "neutral":
      return "offline";
    case "unproductive":
      return "revoked";
  }
}

/** `["Work", "Development"]` → `"Work > Development"`, using the engine's separator. */
export function formatRulePath(path: readonly string[]): string {
  return path.length === 0 ? "Uncategorized" : path.join(CATEGORY_SEPARATOR);
}

/**
 * Parses the path field.
 *
 * Accepts `>` and `/` as separators, because an admin typing a hierarchy will reach
 * for either and refusing one of them teaches nothing.
 */
export function parseRulePath(text: string): string[] {
  return text
    .split(/[>/]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The conditions a rule applies, for the table cell that has to show them. */
export function ruleConditions(rule: CategoryRuleDto): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (rule.matchApp) out.push({ label: "App", value: rule.matchApp });
  if (rule.matchDomain) out.push({ label: "Domain", value: rule.matchDomain });
  if (rule.matchTitle) out.push({ label: "Title", value: rule.matchTitle });
  return out;
}

/** The form's state for one rule. Strings throughout — see {@link PolicyDraft}. */
export interface RuleDraft {
  path: string;
  productivity: Productivity;
  priority: string;
  matchApp: string;
  matchDomain: string;
  matchTitle: string;
  ignoreCase: boolean;
}

export const EMPTY_RULE_DRAFT: RuleDraft = {
  path: "",
  productivity: "productive",
  // 100 is the API's own default for a rule created without one.
  priority: "100",
  matchApp: "",
  matchDomain: "",
  matchTitle: "",
  ignoreCase: true,
};

export function ruleDraftFrom(rule: CategoryRuleDto): RuleDraft {
  return {
    path: formatRulePath(rule.path),
    productivity: rule.productivity,
    priority: String(rule.priority),
    matchApp: rule.matchApp ?? "",
    matchDomain: rule.matchDomain ?? "",
    matchTitle: rule.matchTitle ?? "",
    ignoreCase: rule.ignoreCase,
  };
}

export type RuleDraftErrors = Partial<Record<"path" | "priority" | "match", string>> & {
  matchApp?: string;
  matchDomain?: string;
  matchTitle?: string;
};

/**
 * Checks a rule draft against the engine that will run it.
 *
 * The structural half mirrors the API's zod schema. The second half calls the real
 * {@link compileRules}, which is what the server's own `refuseUnusableRule` does — so
 * a pattern that would be stored and then silently skipped forever is refused here,
 * with the compiler's own words, before it is saved.
 */
export function validateRuleDraft(draft: RuleDraft): RuleDraftErrors {
  const errors: RuleDraftErrors = {};

  const path = parseRulePath(draft.path);
  if (path.length === 0) {
    errors.path = "Give the category a name, for example “Work > Development”.";
  } else if (path.length > 4) {
    errors.path = "Four levels is the deepest a category can go.";
  } else if (path.some((segment) => segment.length > 60)) {
    errors.path = "Each level must be under 60 characters.";
  }

  const priority = Number(draft.priority.trim());
  if (draft.priority.trim() === "" || !Number.isInteger(priority)) {
    errors.priority = "Priority is a whole number. Lower runs first.";
  } else if (priority < 0 || priority > 100_000) {
    errors.priority = "Priority must be between 0 and 100000.";
  }

  const app = draft.matchApp.trim();
  const domain = draft.matchDomain.trim();
  const title = draft.matchTitle.trim();

  for (const [key, value] of [
    ["matchApp", app],
    ["matchDomain", domain],
    ["matchTitle", title],
  ] as const) {
    if (value.length > 400) errors[key] = "That pattern is too long — 400 characters is the limit.";
  }

  if (!app && !domain && !title) {
    errors.match =
      "A rule needs at least one condition. Without one it would claim every event.";
    return errors;
  }

  // The engine is the authority on what it can run. Ask it.
  const rejected = compileRules([
    {
      id: "draft",
      path: path.length > 0 ? path : ["Uncategorized"],
      productivity: draft.productivity,
      priority: Number.isInteger(priority) ? priority : 100,
      matchApp: app || null,
      matchDomain: domain || null,
      matchTitle: title || null,
      ignoreCase: draft.ignoreCase,
    },
  ]).rejected[0];

  if (rejected) {
    const key = rejectionFieldKey(rejected.field);
    if (key === "match") errors.match = rejected.reason;
    else errors[key] = rejected.reason;
  }

  return errors;
}

/**
 * The path a rule-level refusal is reported at.
 *
 * "A rule needs at least one condition" is not about App, Domain or Title — it is
 * about the three of them together, and pinning it to one of the fields would send
 * someone to fix the wrong box. React Hook Form's `errors.root.*` namespace exists for
 * exactly this, so the issue is raised there and rendered above the group.
 */
export const RULE_CONDITIONS_ERROR_PATH = ["root", "conditions"] as const;

/**
 * {@link validateRuleDraft} as a React Hook Form resolver.
 *
 * Same reasoning as {@link policyFormSchema}: the schema delegates rather than
 * duplicates, so the real {@link compileRules} still decides whether a pattern can be
 * run and the existing tests still cover the form.
 */
export const ruleFormSchema = z
  .object({
    path: z.string(),
    productivity: z.enum(["productive", "neutral", "unproductive"]),
    priority: z.string(),
    matchApp: z.string(),
    matchDomain: z.string(),
    matchTitle: z.string(),
    ignoreCase: z.boolean(),
  })
  .superRefine((draft, ctx) => {
    for (const [field, message] of Object.entries(validateRuleDraft(draft))) {
      if (!message) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: field === "match" ? [...RULE_CONDITIONS_ERROR_PATH] : [field],
        message,
      });
    }
  });

export function ruleDraftToInput(draft: RuleDraft): CategoryRuleInput {
  return {
    path: parseRulePath(draft.path),
    productivity: draft.productivity,
    priority: Number(draft.priority.trim()),
    matchApp: draft.matchApp.trim() || null,
    matchDomain: draft.matchDomain.trim() || null,
    matchTitle: draft.matchTitle.trim() || null,
    ignoreCase: draft.ignoreCase,
  };
}

export function hasErrors(errors: object): boolean {
  return Object.keys(errors).length > 0;
}

/** Which form field a compiler rejection belongs to. */
export function rejectionFieldKey(
  field: RejectedRule["field"],
): "matchApp" | "matchDomain" | "matchTitle" | "match" {
  switch (field) {
    case "app":
      return "matchApp";
    case "domain":
      return "matchDomain";
    case "title":
      return "matchTitle";
    case "rule":
      return "match";
  }
}

export function rejectionsByRuleId(
  rejected: readonly RejectedRule[],
): Map<string, RejectedRule> {
  const map = new Map<string, RejectedRule>();
  for (const rejection of rejected) {
    if (!map.has(rejection.ruleId)) map.set(rejection.ruleId, rejection);
  }
  return map;
}

/** The compiler's refusal, as a sentence naming the field it is about. */
export function describeRejection(rejection: RejectedRule): string {
  switch (rejection.field) {
    case "app":
      return `Application pattern: ${rejection.reason}`;
    case "domain":
      return `Domain pattern: ${rejection.reason}`;
    case "title":
      return `Window-title pattern: ${rejection.reason}`;
    case "rule":
      return rejection.reason;
  }
}

/**
 * What a broken rule costs, in the words the panel uses.
 *
 * Not decoration: a rejected rule is skipped silently at ingestion, so an admin
 * looking at an "Uncategorized" report has no way to reach this fact from there.
 */
export function rejectionConsequence(count: number): string {
  if (count === 1) {
    return "One rule cannot be run and is being skipped. Activity it was written to classify is falling through to the rules below it, or to Uncategorized.";
  }
  return `${count} rules cannot be run and are being skipped. Activity they were written to classify is falling through to the rules below them, or to Uncategorized.`;
}

/** Rules in evaluation order, with any refusal attached. First match wins. */
export function rulesWithRejections(
  response: CategoryRulesResponse | undefined,
): { rule: CategoryRuleDto; rejection: RejectedRule | null }[] {
  if (!response) return [];
  const map = rejectionsByRuleId(response.rejected);
  return response.rules.map((rule) => ({ rule, rejection: map.get(rule.id) ?? null }));
}
