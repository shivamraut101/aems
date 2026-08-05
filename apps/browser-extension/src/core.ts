/**
 * Every decision the extension makes, with no `chrome.*` call in sight.
 *
 * `background.ts` is the adapter that gives these functions a browser. Splitting them
 * out is what makes the two rules that actually matter — when a domain may be reported,
 * and when a navigation may be refused — testable without a browser at all.
 */

import type { BridgeStateMessage, MonitoringState, WebsiteRule } from "./protocol.js";

/**
 * The address of a page, or null when it is not one the agent should ever hear about.
 *
 * Only http and https. `chrome://settings`, `about:blank`, a `file://` document and the
 * extension's own pages are not websites anybody visited, and reporting them would put
 * the employee's local filenames into a company activity record — collection nobody
 * consented to and nobody asked for.
 */
export function reportableUrl(url: string | undefined | null): string | null {
  if (typeof url !== "string" || url.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // The agent caps a reported address at 2048 characters and drops the frame past it.
  // Truncating would fabricate an address, so an absurd one is simply not reported.
  return url.length <= 2048 ? url : null;
}

/**
 * Whether a domain may be reported at all.
 *
 * The same consent gate the agent applies to itself (non-negotiable #1), one process
 * further out. The agent would refuse the observation anyway — the API would refuse it
 * after that — but an extension that keeps sending after consent is withdrawn is still
 * an extension that reads every URL for no permitted purpose.
 */
export function mayReport(monitoring: MonitoringState): boolean {
  return monitoring === "collecting";
}

/**
 * Whether the website rules may be applied.
 *
 * Deliberately wider than {@link mayReport}, and the difference is the point.
 * Restriction is a property of a company-owned device's policy, not of the employee's
 * consent to be *observed* — an employee who has not yet accepted the monitoring policy
 * has still been issued a machine that policy governs, and the blocked page names the
 * policy and who to ask about it. What is not defensible is enforcing a policy that
 * does not exist: a machine that was never enrolled, or one whose device has been
 * revoked, has no authority to point at, so its rules are cleared.
 */
export function mayEnforce(monitoring: MonitoringState): boolean {
  return monitoring === "collecting" || monitoring === "consent-required";
}

/** A `declarativeNetRequest` dynamic rule, narrowed to the one shape this extension emits. */
export interface DynamicRule {
  id: number;
  priority: number;
  action: { type: "redirect"; redirect: { extensionPath: string } };
  condition: { requestDomains: string[]; resourceTypes: string[] };
}

/**
 * Turns the policy's restriction list into browser rules.
 *
 * Three deliberate narrowings:
 *
 * - **`main_frame` only.** A restriction is about the page an employee navigates to,
 *   not about every image and script on the web. Blocking subresources would break
 *   unrelated sites that happen to load an asset from a restricted host, and an
 *   employee cannot tell a policy from a broken page.
 * - **`requestDomains`, not a regex.** Chrome matches the host and its subdomains
 *   itself, with no pattern for anyone to get wrong. A hand-built regex is where this
 *   kind of feature silently stops blocking.
 * - **A redirect, never a bare block.** `action: "block"` shows Chrome's own error
 *   page, which is exactly the dead-end "blocked" screen `docs/design.md` rules out.
 *   The redirect goes to a page that names the policy and who to ask.
 */
export function toDynamicRules(rules: readonly WebsiteRule[], blockedPage: string): DynamicRule[] {
  const seen = new Set<number>();
  const built: DynamicRule[] = [];

  for (const rule of rules) {
    const domain = normaliseDomain(rule.domain);
    // Chrome rejects the whole `updateDynamicRules` call if any rule in it is invalid,
    // so one malformed row would take every other restriction down with it.
    if (domain === null || seen.has(rule.id)) continue;
    seen.add(rule.id);

    built.push({
      id: rule.id,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: `/${blockedPage}?rule=${String(rule.id)}` },
      },
      condition: { requestDomains: [domain], resourceTypes: ["main_frame"] },
    });
  }

  return built;
}

/**
 * The bare host a rule names, or null if it does not name one.
 *
 * An administrator will paste `https://www.example.com/path` into a restriction field
 * sooner or later; `requestDomains` takes a host and rejects anything else. `www.` is
 * folded away because Chrome matches subdomains of what it is given — leaving it on
 * would restrict `www.example.com` and quietly permit `example.com`.
 */
export function normaliseDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 253) return null;

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split(/[/?#]/)[0]?.split("@").pop()?.split(":")[0] ?? "";
  const bare = host.startsWith("www.") ? host.slice(4) : host;

  if (bare.length === 0 || bare.length > 253) return null;
  // A host, not a pattern: `*.example.com` and a bare label are both refused, because
  // a rule Chrome would reject takes the whole rule set with it.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(bare)
    ? bare
    : null;
}

/** What the popup and the blocked page are told about the channel. */
export interface ConnectionView {
  connected: boolean;
  headline: string;
  detail: string;
  tone: "ok" | "warn" | "off";
}

/**
 * One sentence an employee can act on.
 *
 * A failed native messaging connection must never read as "everything is fine but
 * quiet": if the host manifest was not registered the extension is inert, and the
 * employee's own readout is the only place that fact surfaces.
 */
export function connectionView(
  state: BridgeStateMessage | null,
  error: string | null,
): ConnectionView {
  if (state === null) {
    return {
      connected: false,
      headline: "Not connected",
      detail:
        error === null
          ? "This extension has not reached the AEMS agent on this computer. Website activity is not being reported and website rules are not being applied."
          : `This extension could not reach the AEMS agent on this computer (${error}). Website activity is not being reported and website rules are not being applied.`,
      tone: "off",
    };
  }

  if (state.monitoring === "revoked") {
    return {
      connected: true,
      headline: "Monitoring stopped",
      detail: "An administrator has stopped monitoring on this device. Nothing is being reported.",
      tone: "warn",
    };
  }

  if (state.monitoring === "not-enrolled") {
    return {
      connected: true,
      headline: "Not signed in",
      detail: "Open the AEMS Agent and sign in. Nothing is being reported until you do.",
      tone: "warn",
    };
  }

  if (state.monitoring === "consent-required") {
    return {
      connected: true,
      headline: "Waiting for your agreement",
      detail:
        "Open the AEMS Agent to read the monitoring policy. No website activity is reported until you accept it.",
      tone: "warn",
    };
  }

  return {
    connected: true,
    headline: "Reporting website activity",
    detail: "The site in the active tab is shared with your organisation's AEMS agent.",
    tone: "ok",
  };
}

/** The rule that stopped a navigation, resolved for the page that replaced it. */
export function findRule(
  state: BridgeStateMessage | null,
  ruleId: number,
): WebsiteRule | null {
  return state?.rules.find((rule) => rule.id === ruleId) ?? null;
}
