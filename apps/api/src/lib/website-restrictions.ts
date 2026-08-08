import type { AemsSupabaseClient } from "@aems/supabase";

/**
 * The website rules an agent — and through it, the managed browser extension — should
 * be enforcing right now.
 *
 * This exists because the feature was built end to end and then never connected. The
 * extension applies `policy.websiteRestrictions`; `websiteRestrictionsOf` in the agent
 * reads that field defensively; the rules are authored in Settings → Website access and
 * stored; `GET /api/restrictions/enforcement` even serves them to a device. And nothing
 * called it. The extension's own README says the rules "the API does not send yet",
 * which was true for as long as website restriction has been in scope: rules were
 * written, saved, shown back to the admin, and enforced nowhere.
 *
 * ## Why only `block` + `domain`
 *
 * The bridge's `WebsiteRule` is `{ id, domain, reason }` — a host and a sentence. The
 * stored vocabulary is wider: `allow` as well as `block`, and `url_pattern` as well as
 * `domain`. Sending a `url_pattern` as if it were a host would block the wrong thing,
 * and an `allow` rule means nothing to a list the extension treats as "refuse these",
 * so both are dropped here rather than mangled into the narrower shape.
 *
 * **Dropped rules are counted and returned**, not silently discarded. An admin who
 * writes a URL-pattern rule and is told nothing has every reason to believe it is in
 * force; the count is what lets a caller say otherwise. Silence here would be the
 * "bare blocked screen" failure from the other direction — enforcement the employee
 * cannot see the rule for, or a rule the admin cannot see the non-enforcement of.
 *
 * `allowlist` mode is likewise not representable: "refuse everything except these"
 * inverts the list, and an extension handed an inverted list as a blocklist would
 * block exactly the sites that are allowed. In that mode this returns no rules at all
 * — failing open, which for a control nobody can express correctly is the only safe
 * direction.
 */
export interface ResolvedWebsiteRestrictions {
  rules: { id: number; domain: string; reason: string | null }[];
  contact: string | null;
  /** Bumped by the API whenever settings or rules change; the agent's cache key. */
  revision: number;
  /** Rules the browser cannot express. Zero unless an admin wrote one. */
  unenforceable: number;
}

export const EMPTY_RESTRICTIONS: ResolvedWebsiteRestrictions = {
  rules: [],
  contact: null,
  revision: 0,
  unenforceable: 0,
};

/**
 * A stable 31-bit id for a uuid.
 *
 * `declarativeNetRequest` rule ids must be positive integers, and the protocol comment
 * says the id has to be stable so the browser can diff its own rule set — so it cannot
 * be an array index, which shifts the moment a rule above it is deleted. FNV-1a over
 * the uuid: deterministic across processes and restarts, no state to keep.
 *
 * ponytail: 31-bit hash, so a collision is possible around ~2^15 rules on one tenant.
 * A collision costs one dropped rule, not a wrong block. Swap for a database identity
 * column if a company ever writes thousands.
 */
export function ruleIdOf(uuid: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i += 1) {
    hash ^= uuid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1;
}

interface SettingsRow {
  enabled: boolean;
  mode: string;
  notice: string | null;
  revision: number;
}

interface RuleRow {
  id: string;
  action: string;
  match_kind: string;
  pattern: string;
  note: string | null;
  enabled: boolean;
}

/** Pure half, so the mapping is testable without a database. */
export function resolveRestrictions(
  settings: SettingsRow | null,
  rules: readonly RuleRow[],
): ResolvedWebsiteRestrictions {
  // No settings row, or the whole control switched off, means enforce nothing. The
  // rules stay authored and stored — an admin turning restriction off must not have to
  // rewrite their list to turn it back on.
  if (!settings || !settings.enabled) {
    return { ...EMPTY_RESTRICTIONS, revision: settings?.revision ?? 0, contact: settings?.notice ?? null };
  }

  if (settings.mode !== "blocklist") {
    return {
      rules: [],
      contact: settings.notice,
      revision: settings.revision,
      unenforceable: rules.filter((rule) => rule.enabled).length,
    };
  }

  const live = rules.filter((rule) => rule.enabled);
  const enforceable = live.filter((rule) => rule.action === "block" && rule.match_kind === "domain");

  return {
    rules: enforceable.map((rule) => ({
      id: ruleIdOf(rule.id),
      domain: rule.pattern,
      reason: rule.note,
    })),
    contact: settings.notice,
    revision: settings.revision,
    unenforceable: live.length - enforceable.length,
  };
}

/** Reads both tables and resolves them. One round trip each, run together. */
export async function loadWebsiteRestrictions(
  supabase: AemsSupabaseClient,
  companyId: string,
): Promise<ResolvedWebsiteRestrictions> {
  const [settings, rules] = await Promise.all([
    supabase
      .from("website_restriction_settings")
      .select("enabled, mode, notice, revision")
      .eq("company_id", companyId)
      .maybeSingle(),
    supabase
      .from("website_restriction_rules")
      .select("id, action, match_kind, pattern, note, enabled")
      .eq("company_id", companyId)
      .order("priority", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  return resolveRestrictions(
    (settings.data ?? null) as SettingsRow | null,
    (rules.data ?? []) as RuleRow[],
  );
}
