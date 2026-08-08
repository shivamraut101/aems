import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import {
  EMPTY_RULE_DRAFT,
  IDLE_THRESHOLD_OPTIONS,
  POLICY_ROLLOUT_NOTE,
  PRODUCTIVITY_OPTIONS,
  SCREENSHOT_INTERVAL_OPTIONS,
  describeRejection,
  formatRulePath,
  hasErrors,
  intervalLabel,
  intervalOptionsWith,
  monitoringChangeConfirmation,
  monitoringConsequence,
  parseRulePath,
  parseTrackedCategories,
  policyChanges,
  policyDraftFrom,
  policyDraftToInput,
  policyState,
  productivityBadgeVariant,
  productivityLabel,
  rejectionConsequence,
  rejectionFieldKey,
  rejectionsByRuleId,
  ruleConditions,
  ruleDraftFrom,
  ruleDraftToInput,
  ruleFormSchema,
  rulesWithRejections,
  policyFormSchema,
  RULE_CONDITIONS_ERROR_PATH,
  screenshotIntervalChoices,
  screenshotsPerDay,
  validatePolicyDraft,
  validateRuleDraft,
  type CategoryRuleDto,
  type PolicyDraft,
  type PolicyRecord,
  type RuleDraft,
} from "./settings-view";

const policy: PolicyRecord = {
  id: "pol-1",
  company_id: "co-1",
  version: "2026.1",
  name: "Standard monitoring policy",
  screenshot_interval_seconds: 300,
  idle_threshold_seconds: 120,
  tracked_categories: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("intervalLabel", () => {
  it("renders whole minutes as minutes", () => {
    expect(intervalLabel(60)).toBe("1 min");
    expect(intervalLabel(300)).toBe("5 min");
    expect(intervalLabel(1800)).toBe("30 min");
  });

  it("renders sub-minute thresholds as seconds", () => {
    expect(intervalLabel(30)).toBe("30 sec");
  });

  it("keeps a value that is not a whole number of minutes honest", () => {
    expect(intervalLabel(90)).toBe("1 min 30 sec");
  });

  it("renders an hour or more in hours", () => {
    expect(intervalLabel(3600)).toBe("1 h");
    expect(intervalLabel(5400)).toBe("1 h 30 min");
  });
});

describe("SCREENSHOT_INTERVAL_OPTIONS", () => {
  it("offers exactly the five intervals scope 2.3 names", () => {
    expect(SCREENSHOT_INTERVAL_OPTIONS.map((option) => option.seconds)).toEqual([
      60, 300, 600, 900, 1800,
    ]);
  });

  it("labels each one the way the picker will read", () => {
    expect(SCREENSHOT_INTERVAL_OPTIONS.map((option) => option.label)).toEqual([
      "1 min",
      "5 min",
      "10 min",
      "15 min",
      "30 min",
    ]);
  });
});

describe("screenshotsPerDay", () => {
  it("states the volume an interval implies over an eight-hour day", () => {
    expect(screenshotsPerDay(300)).toBe(96);
    expect(screenshotsPerDay(60)).toBe(480);
  });

  it("is zero rather than Infinity for a nonsense interval", () => {
    expect(screenshotsPerDay(0)).toBe(0);
    expect(screenshotsPerDay(-5)).toBe(0);
  });
});

describe("policyState", () => {
  it("is loading while the first request is in flight", () => {
    expect(policyState({ isLoading: true, error: null, data: undefined })).toBe("loading");
  });

  it("is ready when a policy came back", () => {
    expect(policyState({ isLoading: false, error: null, data: policy })).toBe("ready");
  });

  /**
   * The distinction that matters: a company with no policy row is a setup step, not
   * a fault. Rendering a red error box on day one of a demo makes an empty database
   * look like a broken deployment.
   */
  it("is missing — not error — for a 404", () => {
    expect(
      policyState({
        isLoading: false,
        error: new ApiError("That record could not be found.", 404, "not_found", null),
        data: undefined,
      }),
    ).toBe("missing");
  });

  it("is missing when the request succeeded and returned nothing", () => {
    expect(policyState({ isLoading: false, error: null, data: null })).toBe("missing");
  });

  it("is forbidden for a 403, which is a different sentence entirely", () => {
    expect(
      policyState({
        isLoading: false,
        error: new ApiError("You do not have access to this.", 403, "forbidden", null),
        data: undefined,
      }),
    ).toBe("forbidden");
  });

  it("is error for anything else", () => {
    expect(
      policyState({
        isLoading: false,
        error: new ApiError("The service is temporarily unavailable.", 503, "oops", null),
        data: undefined,
      }),
    ).toBe("error");
    expect(
      policyState({ isLoading: false, error: new NetworkError("never landed"), data: undefined }),
    ).toBe("error");
  });
});

describe("monitoringConsequence", () => {
  /**
   * Compliance copy, not decoration. Non-negotiable #1 makes consent the gate and #4
   * makes revocation immediate; a toggle that says only "Monitoring: off" leaves the
   * admin guessing whether history is deleted and when collection actually stops.
   */
  it("says what stops, what is kept, and when it takes effect", () => {
    const off = monitoringConsequence(true);
    expect(off.action).toBe("Pause monitoring");
    expect(off.detail).toContain("stops collecting");
    expect(off.detail).toContain("next");
    expect(off.detail).toContain("kept");
  });

  it("says what resuming does, and does not promise backfill", () => {
    const on = monitoringConsequence(false);
    expect(on.action).toBe("Resume monitoring");
    expect(on.detail).toContain("consent");
    expect(on.detail).not.toContain("backfill");
  });

  it("never uses surveillance language", () => {
    const forbidden = ["spy", "surveil", "catch", "watch"];
    for (const enabled of [true, false]) {
      const copy = monitoringConsequence(enabled);
      const text = `${copy.action} ${copy.detail}`.toLowerCase();
      for (const word of forbidden) expect(text).not.toContain(word);
    }
  });
});

describe("monitoringChangeConfirmation", () => {
  it("names the person and restates when collection actually stops", () => {
    const text = monitoringChangeConfirmation("Sarah Chen", false);
    expect(text).toContain("Sarah Chen");
    expect(text).toContain("paused");
    expect(text).toContain("next check-in");
    expect(text).toContain("kept");
  });

  it("does not promise that resuming re-consents on the employee's behalf", () => {
    const text = monitoringChangeConfirmation("Sarah Chen", true);
    expect(text).toContain("resumed");
    expect(text).toContain("consent");
  });

  it("never uses surveillance language", () => {
    for (const enabled of [true, false]) {
      const text = monitoringChangeConfirmation("Sarah Chen", enabled).toLowerCase();
      for (const word of ["spy", "surveil", "catch"]) expect(text).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// Publishing a policy
// ---------------------------------------------------------------------------

const draft: PolicyDraft = {
  version: "",
  name: "Standard monitoring policy",
  screenshotIntervalSeconds: 300,
  idleThresholdSeconds: 300,
  trackedCategories: "",
};

describe("policyDraftFrom", () => {
  /**
   * The form seeds from the policy in force, so publishing a change to one field
   * does not silently reset the other three to whatever the defaults happen to be.
   */
  it("carries every field of the policy in force forward", () => {
    const seeded = policyDraftFrom({
      ...policy,
      screenshot_interval_seconds: 900,
      idle_threshold_seconds: 45,
      tracked_categories: ["Development", "Research"],
    });
    expect(seeded.screenshotIntervalSeconds).toBe(900);
    expect(seeded.idleThresholdSeconds).toBe(45);
    expect(seeded.trackedCategories).toBe("Development, Research");
    expect(seeded.name).toBe(policy.name);
  });

  /**
   * Blank, never a guess. The API mints the next label in its own `YYYY.MM.N`
   * series; a dashboard that invented one would either collide with a version
   * consent is already recorded against, or start a second numbering scheme
   * running alongside the server's.
   */
  it("leaves the version blank so the server assigns it", () => {
    expect(policyDraftFrom(policy).version).toBe("");
    expect(policyDraftFrom(null).version).toBe("");
  });

  it("offers workable defaults for the very first policy", () => {
    const seeded = policyDraftFrom(null);
    expect(seeded.screenshotIntervalSeconds).toBe(300);
    expect(seeded.idleThresholdSeconds).toBe(300);
    expect(seeded.trackedCategories).toBe("");
    expect(seeded.name).not.toBe("");
  });
});

describe("policyChanges", () => {
  it("lists only the fields that actually move", () => {
    const draft = { ...policyDraftFrom(policy), screenshotIntervalSeconds: 60 };
    const changes = policyChanges(draft, policy);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      label: "Screenshot interval",
      from: "5 min",
      to: "1 min",
    });
  });

  /**
   * The point of the confirmation. Re-publishing an unchanged draft still mints a
   * version, and a diff that invented changes would make every publish look alarming —
   * which is how a person learns to click through the one that is not.
   */
  it("is empty when nothing an agent reads has changed", () => {
    expect(policyChanges(policyDraftFrom(policy), policy)).toEqual([]);
  });

  /**
   * The version label is deliberately absent: it is usually the server's to mint, so
   * quoting it would either be blank or be a guess, and it is the one field that always
   * differs.
   */
  it("says nothing about the version, which the server assigns", () => {
    const draft = { ...policyDraftFrom(policy), version: "2026.99" };
    expect(policyChanges(draft, policy)).toEqual([]);
  });

  it("presents the first policy as new rather than as a change from nothing", () => {
    const changes = policyChanges(policyDraftFrom(null), null);
    expect(changes.every((change) => change.from === null)).toBe(true);
    expect(changes.map((change) => change.label)).toContain("Screenshot interval");
  });

  it("names an emptied category list rather than showing a blank", () => {
    // "All activity" and "nothing is tracked" are opposite facts, and an empty list
    // means the first one.
    const tracked: PolicyRecord = { ...policy, tracked_categories: ["Development"] };
    const changes = policyChanges({ ...policyDraftFrom(tracked), trackedCategories: "" }, tracked);

    expect(changes).toEqual([
      { label: "Tracked categories", from: "Development", to: "All activity" },
    ]);
  });
});

describe("screenshotIntervalChoices", () => {
  it("offers exactly the five the API accepts", () => {
    const choices = screenshotIntervalChoices(300);
    expect(choices.map((choice) => choice.seconds)).toEqual([60, 300, 600, 900, 1800]);
    expect(choices.every((choice) => choice.standard)).toBe(true);
  });

  /**
   * A company whose row was written by hand still sees its real interval, flagged —
   * rather than the select silently rewriting it to whichever option came first.
   * `validatePolicyDraft` then refuses to publish it, which is the honest sequence.
   */
  it("shows a non-standard interval already in force, and marks it", () => {
    const choices = screenshotIntervalChoices(45);
    const odd = choices.find((choice) => choice.seconds === 45);
    expect(odd?.standard).toBe(false);
    expect(odd?.label).toContain("not a standard interval");
    expect(choices[0]?.seconds).toBe(45);
  });
});

describe("intervalOptionsWith", () => {
  it("leaves a standard interval alone", () => {
    expect(intervalOptionsWith(SCREENSHOT_INTERVAL_OPTIONS, 300)).toHaveLength(
      SCREENSHOT_INTERVAL_OPTIONS.length,
    );
  });

  /**
   * A company running 45 seconds must not have it silently rewritten to 60 by a
   * `<select>` that had no such option. The edit nobody asked for is the dangerous one.
   */
  it("keeps a non-standard value the company already runs, in order", () => {
    const options = intervalOptionsWith(IDLE_THRESHOLD_OPTIONS, 45);
    expect(options[0]).toEqual({ seconds: 45, label: "45 sec" });
    expect(options).toHaveLength(IDLE_THRESHOLD_OPTIONS.length + 1);
  });

  it("ignores a nonsense value rather than offering it", () => {
    expect(intervalOptionsWith(IDLE_THRESHOLD_OPTIONS, 0)).toHaveLength(
      IDLE_THRESHOLD_OPTIONS.length,
    );
  });
});

describe("parseTrackedCategories", () => {
  it("splits, trims and drops blanks", () => {
    expect(parseTrackedCategories(" Development , Research ,, ")).toEqual([
      "Development",
      "Research",
    ]);
  });

  it("drops case-insensitive duplicates but keeps the order typed", () => {
    expect(parseTrackedCategories("Research, research, Development")).toEqual([
      "Research",
      "Development",
    ]);
  });

  it("is empty for an empty field, which the API reads as all activity", () => {
    expect(parseTrackedCategories("   ")).toEqual([]);
  });
});

describe("validatePolicyDraft", () => {
  it("accepts a sound draft, blank version included", () => {
    expect(validatePolicyDraft(draft)).toEqual({});
    expect(hasErrors(validatePolicyDraft(draft))).toBe(false);
  });

  it("requires a name", () => {
    expect(validatePolicyDraft({ ...draft, name: "   " }).name).toBeDefined();
    expect(validatePolicyDraft({ ...draft, name: "x".repeat(161) }).name).toBeDefined();
  });

  it("accepts a hand-picked version that fits the API's pattern", () => {
    expect(validatePolicyDraft({ ...draft, version: "2026.08.4" })).toEqual({});
  });

  /** Copied from `policyDraftSchema`, not approximated — the label is quoted in consent records. */
  it("refuses a version the API's pattern would refuse", () => {
    expect(validatePolicyDraft({ ...draft, version: "-nope" }).version).toBeDefined();
    expect(validatePolicyDraft({ ...draft, version: "has space" }).version).toBeDefined();
    expect(validatePolicyDraft({ ...draft, version: "x".repeat(41) }).version).toBeDefined();
  });

  /**
   * Publishing is an insert, and consent is recorded against a version string. Two
   * rows sharing one version makes "which policy was in force for this screenshot"
   * unanswerable — so the duplicate is refused here, before the round trip. The
   * server checks the whole series and answers 409; this is the courtesy, not the
   * boundary.
   */
  it("refuses a version that already exists", () => {
    expect(validatePolicyDraft({ ...draft, version: "2026.1" }, ["2026.1"]).version).toContain(
      "2026.1",
    );
  });

  it("compares versions after trimming, so whitespace is not a new version", () => {
    expect(validatePolicyDraft({ ...draft, version: " 2026.1 " }, ["2026.1"]).version).toBeDefined();
  });

  /**
   * The API accepts exactly the five intervals `docs/scope.md` §2.3 names — the
   * column check is only `>= 30`, so the schema is the narrower authority and this
   * has to agree with it or the form accepts a value the server rejects.
   */
  it("refuses any screenshot interval outside the five standard options", () => {
    expect(
      validatePolicyDraft({ ...draft, screenshotIntervalSeconds: 45 }).screenshotIntervalSeconds,
    ).toBeDefined();
    expect(
      validatePolicyDraft({ ...draft, screenshotIntervalSeconds: 120 }).screenshotIntervalSeconds,
    ).toBeDefined();
    for (const option of SCREENSHOT_INTERVAL_OPTIONS) {
      expect(
        validatePolicyDraft({ ...draft, screenshotIntervalSeconds: option.seconds })
          .screenshotIntervalSeconds,
      ).toBeUndefined();
    }
  });

  it("holds the idle threshold to the API's 30-second-to-one-hour range", () => {
    expect(validatePolicyDraft({ ...draft, idleThresholdSeconds: 29 }).idleThresholdSeconds).toBeDefined();
    expect(
      validatePolicyDraft({ ...draft, idleThresholdSeconds: 7200 }).idleThresholdSeconds,
    ).toBeDefined();
    expect(
      validatePolicyDraft({ ...draft, idleThresholdSeconds: Number.NaN }).idleThresholdSeconds,
    ).toBeDefined();
    expect(
      validatePolicyDraft({ ...draft, idleThresholdSeconds: 45 }).idleThresholdSeconds,
    ).toBeUndefined();
  });

  it("refuses a category list the API would refuse", () => {
    const many = Array.from({ length: 51 }, (_, index) => `Category ${index}`).join(", ");
    expect(validatePolicyDraft({ ...draft, trackedCategories: many }).trackedCategories).toBeDefined();
    expect(
      validatePolicyDraft({ ...draft, trackedCategories: "x".repeat(61) }).trackedCategories,
    ).toBeDefined();
  });
});

describe("policyDraftToInput", () => {
  /** Omitting `version` is how the server is asked to mint the next one. */
  it("omits the version entirely when the field is blank", () => {
    expect(policyDraftToInput({ ...draft, version: "  " })).toEqual({
      name: "Standard monitoring policy",
      screenshotIntervalSeconds: 300,
      idleThresholdSeconds: 300,
      trackedCategories: [],
    });
  });

  it("sends camelCase, trimmed, with the categories parsed into an array", () => {
    expect(policyDraftToInput({ ...draft, version: " 2026.08.3 ", trackedCategories: "A, B" })).toEqual(
      {
        version: "2026.08.3",
        name: "Standard monitoring policy",
        screenshotIntervalSeconds: 300,
        idleThresholdSeconds: 300,
        trackedCategories: ["A", "B"],
      },
    );
  });
});

describe("POLICY_ROLLOUT_NOTE", () => {
  /**
   * Both halves, because this note has now been wrong in each direction. It first
   * claimed agents picked a change up "at their next check-in", which the server did
   * not do; it then said "the heartbeat does not carry a policy today", which stopped
   * being true when the heartbeat began answering with the version and the permitted
   * data types.
   *
   * What the heartbeat still does **not** deliver is the interval and the threshold —
   * those arrive at enrolment — so the note has to name both mechanisms and must not
   * promise a live rollout of the cadence.
   */
  it("names both delivery mechanisms and over-claims neither", () => {
    expect(POLICY_ROLLOUT_NOTE).toContain("enrol");
    expect(POLICY_ROLLOUT_NOTE).toContain("heartbeat");
    expect(POLICY_ROLLOUT_NOTE).toContain("interval");
    expect(POLICY_ROLLOUT_NOTE).not.toContain("does not carry a policy");
  });
});

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------

const rule: CategoryRuleDto = {
  id: "rule-1",
  path: ["Work", "Development"],
  productivity: "productive",
  priority: 10,
  matchApp: "^Code$",
  matchDomain: null,
  matchTitle: null,
  ignoreCase: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("formatRulePath / parseRulePath", () => {
  it("renders a path with the engine's own separator", () => {
    expect(formatRulePath(["Work", "Development"])).toBe("Work > Development");
  });

  it("names an empty path rather than rendering a blank", () => {
    expect(formatRulePath([])).toBe("Uncategorized");
  });

  it("accepts either separator an admin will reach for", () => {
    expect(parseRulePath("Work > Development")).toEqual(["Work", "Development"]);
    expect(parseRulePath("Work/Development")).toEqual(["Work", "Development"]);
  });

  it("drops empty segments instead of storing a blank level", () => {
    expect(parseRulePath(" Work >> Development > ")).toEqual(["Work", "Development"]);
    expect(parseRulePath("   ")).toEqual([]);
  });

  it("round-trips through the draft", () => {
    expect(parseRulePath(ruleDraftFrom(rule).path)).toEqual(rule.path);
  });
});

describe("ruleConditions", () => {
  it("lists only the conditions the rule actually sets", () => {
    expect(ruleConditions(rule)).toEqual([{ label: "App", value: "^Code$" }]);
  });

  it("lists all three when all three are set, in match order", () => {
    expect(
      ruleConditions({ ...rule, matchDomain: "github.com", matchTitle: "Alpha" }).map(
        (condition) => condition.label,
      ),
    ).toEqual(["App", "Domain", "Title"]);
  });
});

describe("ruleDraftFrom / ruleDraftToInput", () => {
  it("round-trips a rule without changing it", () => {
    expect(ruleDraftToInput(ruleDraftFrom(rule))).toEqual({
      path: ["Work", "Development"],
      productivity: "productive",
      priority: 10,
      matchApp: "^Code$",
      matchDomain: null,
      matchTitle: null,
      ignoreCase: true,
    });
  });

  it("sends null, not empty string, for a condition left blank", () => {
    const input = ruleDraftToInput({ ...EMPTY_RULE_DRAFT, path: "Work", matchDomain: " " });
    expect(input.matchApp).toBeNull();
    expect(input.matchDomain).toBeNull();
    expect(input.matchTitle).toBeNull();
  });
});

describe("validateRuleDraft", () => {
  const sound: RuleDraft = {
    path: "Work > Development",
    productivity: "productive",
    priority: "10",
    matchApp: "^Code$",
    matchDomain: "",
    matchTitle: "",
    ignoreCase: true,
  };

  it("accepts a sound rule", () => {
    expect(validateRuleDraft(sound)).toEqual({});
  });

  it("requires a category name", () => {
    expect(validateRuleDraft({ ...sound, path: "  " }).path).toBeDefined();
  });

  it("refuses a path deeper than four levels or a level over 60 characters", () => {
    expect(validateRuleDraft({ ...sound, path: "a > b > c > d > e" }).path).toBeDefined();
    expect(validateRuleDraft({ ...sound, path: "x".repeat(61) }).path).toBeDefined();
  });

  it("refuses a priority that is not a whole number in range", () => {
    expect(validateRuleDraft({ ...sound, priority: "" }).priority).toBeDefined();
    expect(validateRuleDraft({ ...sound, priority: "1.5" }).priority).toBeDefined();
    expect(validateRuleDraft({ ...sound, priority: "-1" }).priority).toBeDefined();
    expect(validateRuleDraft({ ...sound, priority: "100001" }).priority).toBeDefined();
  });

  /**
   * The engine rejects a rule with no condition rather than letting it claim every
   * event. Catching it here means the admin is told why instead of being handed the
   * server's 400.
   */
  it("refuses a rule with no condition at all", () => {
    const errors = validateRuleDraft({ ...sound, matchApp: "" });
    expect(errors.match).toContain("at least one condition");
  });

  /**
   * The important one. `compileRules` skips an uncompilable rule silently at
   * ingestion, so a pattern accepted by this form would be stored and never run.
   * Validating through the real compiler means the form refuses exactly what the
   * engine refuses — not an approximation of it.
   */
  it("refuses a pattern the real engine cannot compile, and blames the right field", () => {
    const errors = validateRuleDraft({ ...sound, matchApp: "(" });
    expect(errors.matchApp).toBeDefined();
    expect(errors.match).toBeUndefined();
  });

  it("refuses a pathological domain pattern on the domain field", () => {
    const errors = validateRuleDraft({ ...sound, matchApp: "", matchDomain: "(a+)+$" });
    expect(errors.matchDomain).toBeDefined();
  });

  it("accepts a bare hostname, which the engine matches as a suffix", () => {
    expect(validateRuleDraft({ ...sound, matchApp: "", matchDomain: "github.com" })).toEqual({});
  });

  it("refuses a pattern over the 400-character API limit", () => {
    expect(validateRuleDraft({ ...sound, matchApp: "a".repeat(401) }).matchApp).toBeDefined();
  });
});

describe("rejections", () => {
  it("maps each engine field onto the form field that owns it", () => {
    expect(rejectionFieldKey("app")).toBe("matchApp");
    expect(rejectionFieldKey("domain")).toBe("matchDomain");
    expect(rejectionFieldKey("title")).toBe("matchTitle");
    expect(rejectionFieldKey("rule")).toBe("match");
  });

  it("names the field in the sentence, because a bare reason is unactionable", () => {
    expect(describeRejection({ ruleId: "r", field: "app", reason: "Unterminated group" })).toBe(
      "Application pattern: Unterminated group",
    );
    expect(describeRejection({ ruleId: "r", field: "rule", reason: "Needs a condition" })).toBe(
      "Needs a condition",
    );
  });

  it("indexes by rule id, keeping the first refusal for a rule", () => {
    const map = rejectionsByRuleId([
      { ruleId: "a", field: "app", reason: "first" },
      { ruleId: "a", field: "title", reason: "second" },
    ]);
    expect(map.get("a")?.reason).toBe("first");
  });

  /**
   * The count is the point: a rejected rule is skipped silently at ingestion, so an
   * admin staring at an "Uncategorized" report has no route to this fact from there.
   */
  it("states the consequence, in the singular and the plural", () => {
    expect(rejectionConsequence(1)).toContain("One rule");
    expect(rejectionConsequence(1)).toContain("Uncategorized");
    expect(rejectionConsequence(3)).toContain("3 rules");
  });
});

describe("rulesWithRejections", () => {
  it("is empty before the request lands", () => {
    expect(rulesWithRejections(undefined)).toEqual([]);
  });

  it("attaches each refusal to its rule and leaves the API's order intact", () => {
    const second = { ...rule, id: "rule-2", matchApp: "(" };
    const rows = rulesWithRejections({
      rules: [rule, second],
      rejected: [{ ruleId: "rule-2", field: "app", reason: "Unterminated group" }],
    });

    expect(rows.map((row) => row.rule.id)).toEqual(["rule-1", "rule-2"]);
    expect(rows[0]?.rejection).toBeNull();
    expect(rows[1]?.rejection?.reason).toBe("Unterminated group");
  });
});

describe("productivity presentation", () => {
  it("offers exactly the three values the engine and the API enum know", () => {
    expect(PRODUCTIVITY_OPTIONS.map((option) => option.value)).toEqual([
      "productive",
      "neutral",
      "unproductive",
    ]);
  });

  it("labels each one for a reader", () => {
    expect(productivityLabel("unproductive")).toBe("Unproductive");
  });

  /** Reuses the presence palette; indigo stays reserved for AI surfaces. */
  it("maps each classification onto a distinct existing badge variant", () => {
    const variants = PRODUCTIVITY_OPTIONS.map((option) => productivityBadgeVariant(option.value));
    expect(variants).toEqual(["online", "offline", "revoked"]);
    expect(new Set(variants).size).toBe(3);
  });
});

describe("hasErrors", () => {
  it("is false only for an empty error object", () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ version: "nope" })).toBe(true);
  });
});

/**
 * The two React Hook Form resolvers.
 *
 * They exist so `CLAUDE.md`'s "all forms: React Hook Form + Zod" holds on this screen
 * without the validation rules being written out a second time — each schema delegates
 * to the validator directly above it, which is what every assertion in this file
 * already covers. What is asserted here is only the *wiring*: that a refusal reaches
 * the field it is about, because a message that lands on the wrong path is a message
 * the form never renders.
 */
describe("policyFormSchema", () => {
  it("accepts the draft a published policy seeds", () => {
    const parsed = policyFormSchema().safeParse(policyDraftFrom(null));
    expect(parsed.success).toBe(true);
  });

  it("reports each refusal on the field it belongs to", () => {
    const parsed = policyFormSchema().safeParse({
      ...policyDraftFrom(null),
      name: "",
      screenshotIntervalSeconds: 45,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("name");
      expect(paths).toContain("screenshotIntervalSeconds");
    }
  });

  it("carries the duplicate-version check, which needs data the schema does not hold", () => {
    const parsed = policyFormSchema(["2026.08.1"]).safeParse({
      ...policyDraftFrom(null),
      version: "2026.08.1",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["version"]);
      expect(parsed.error.issues[0]?.message).toMatch(/already exists/);
    }
  });
});

describe("ruleFormSchema", () => {
  it("accepts a rule the engine can run", () => {
    const parsed = ruleFormSchema.safeParse({
      ...EMPTY_RULE_DRAFT,
      path: "Work > Development",
      matchApp: "^Code$",
    });
    expect(parsed.success).toBe(true);
  });

  it("reports a field-level refusal on that field", () => {
    const parsed = ruleFormSchema.safeParse({
      ...EMPTY_RULE_DRAFT,
      path: "Work",
      matchDomain: "(unclosed",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain("matchDomain");
    }
  });

  it("reports a rule-level refusal at root.conditions, not on one arbitrary field", () => {
    const parsed = ruleFormSchema.safeParse({ ...EMPTY_RULE_DRAFT, path: "Work" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((candidate) => candidate.message.includes("condition"));
      expect(issue?.path).toEqual([...RULE_CONDITIONS_ERROR_PATH]);
    }
  });
});
