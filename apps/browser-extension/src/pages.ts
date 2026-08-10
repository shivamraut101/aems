/**
 * The text both extension pages render, decided without a DOM.
 *
 * Kept apart from the two entry points so the wording that carries the compliance
 * obligations — naming the policy that refused a page, and naming who can change it —
 * is exercisable in a test rather than only by loading a browser.
 */

import type { BridgePolicy, WebsiteRule } from "./protocol.js";

/** One `<dt>/<dd>` pair. */
export interface DetailRow {
  label: string;
  value: string;
}

export interface PageState {
  monitoring: string | null;
  policy: BridgePolicy | null;
  contact: string | null;
  restrictedCount: number;
  rule: WebsiteRule | null;
  /** Null is "the agent did not say"; both pages read that as permitting, as the host does. */
  websites: boolean | null;
}

/**
 * The facts under the popup's headline.
 *
 * Deliberately short. A popup that lists everything it knows is a popup nobody reads,
 * and the one thing an employee needs from it is whether their browsing is being
 * reported right now and under what policy.
 */
export function popupRows(state: PageState): DetailRow[] {
  const rows: DetailRow[] = [];

  if (state.policy !== null) {
    rows.push({ label: "Policy", value: state.policy.name });
    rows.push({ label: "Version", value: state.policy.version });
  }

  rows.push({
    label: "Restricted sites",
    value: state.restrictedCount === 0 ? "None" : String(state.restrictedCount),
  });

  if (state.contact !== null) rows.push({ label: "Questions", value: state.contact });

  return rows;
}

/**
 * The facts on the page that replaced a restricted site.
 *
 * `docs/design.md` rules out a dead-end "blocked" screen, and the client's scope
 * decision restates it: an employee must be able to see which policy blocked a page and
 * who to ask about it. So the policy is always named — and when the extension cannot
 * reach the agent to learn it, that is said out loud rather than left blank, because a
 * page that refuses a navigation and cannot say on whose authority is the exact failure
 * being avoided.
 */
export function blockedRows(state: PageState): DetailRow[] {
  return [
    {
      label: "Policy",
      value:
        state.policy === null
          ? "Not available — the AEMS agent is not reachable"
          : `${state.policy.name} (${state.policy.version})`,
    },
    {
      label: "Ask",
      value: state.contact ?? "Your IT administrator or your manager",
    },
  ];
}

/**
 * The standing sentence at the foot of the blocked page.
 *
 * It has to be state-dependent, because restriction is deliberately wider than
 * observation: `mayEnforce` covers a machine whose employee has not accepted the
 * monitoring policy yet, so this page is reachable by design in a state where nothing at
 * all is being recorded. Telling that person their browsing is already reported is the
 * one reading that makes the consent screen they have not signed look like theatre.
 *
 * The popup scopes its own disclosure with "only while the status above says it is";
 * this page carries no status, so the scoping has to be in the sentence.
 */
export function blockedFooter(state: PageState): string {
  const restriction =
    "This restriction comes from the device policy named above, and the person named above can change it.";

  if (state.monitoring !== "collecting") {
    return `Nothing you open in this browser is being recorded at the moment. ${restriction}`;
  }

  if (state.websites === false) {
    return `The addresses of pages you open are not recorded on this work device — your organisation has switched that off. ${restriction}`;
  }

  return `The addresses of pages you open in this browser are reported to the AEMS agent on this work device. ${restriction}`;
}

/** The headline on the blocked page. Names the domain when the rule is known. */
export function blockedHeadline(rule: WebsiteRule | null): string {
  return rule === null
    ? "This site is restricted on this device"
    : `${rule.domain} is restricted on this device`;
}

/**
 * The sentence under the headline.
 *
 * The reason an administrator wrote is preferred over anything this extension could
 * invent, because it is the only text in the product that explains the decision in the
 * employee's own working context.
 */
export function blockedReason(rule: WebsiteRule | null): string | null {
  const reason = rule?.reason?.trim();
  return reason === undefined || reason.length === 0 ? null : reason;
}

/**
 * Reads the rule id out of the URL the redirect produced.
 *
 * Anything that is not a positive integer is treated as absent: the page still renders
 * — naming the policy and the contact — rather than failing, because an employee
 * looking at a refused navigation needs an explanation more than the page needs a rule.
 */
export function ruleIdFrom(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("rule");
  if (raw === null) return undefined;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
