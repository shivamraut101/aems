/**
 * The page that replaces a restricted site.
 *
 * `docs/design.md` rules out a dead-end "blocked" screen, and the scope decision that
 * put website restriction in the MVP restates it: an employee must be able to see which
 * policy blocked the page and who to ask about it. That is the whole specification for
 * this file — name the rule, quote the administrator's reason, name the policy, name
 * the contact, and give a way back.
 */

import type { PageAnswer } from "./background.js";
import { blockedHeadline, blockedReason, blockedRows, ruleIdFrom } from "./pages.js";
import { renderRows, setText } from "./render.js";

async function paint(): Promise<void> {
  const ruleId = ruleIdFrom(window.location.search);

  let answer: PageAnswer | null = null;
  try {
    answer = (await chrome.runtime.sendMessage({ type: "aems:state", ruleId })) as PageAnswer;
  } catch {
    // The service worker would not wake. The page still renders — with the policy row
    // saying the agent is unreachable — because an employee looking at a refused
    // navigation needs an explanation more than the page needs a complete answer.
    answer = null;
  }

  const rule = answer?.rule ?? null;

  setText("headline", blockedHeadline(rule));

  const reason = blockedReason(rule);
  const reasonBlock = document.getElementById("reason-block");
  if (reason === null) {
    reasonBlock?.setAttribute("hidden", "");
  } else {
    setText("reason", reason);
    reasonBlock?.removeAttribute("hidden");
  }

  const rows = document.getElementById("rows");
  if (rows !== null) {
    renderRows(
      rows,
      blockedRows({
        monitoring: answer?.monitoring ?? null,
        policy: answer?.policy ?? null,
        contact: answer?.contact ?? null,
        restrictedCount: answer?.restrictedCount ?? 0,
        rule,
      }),
    );
  }
}

document.getElementById("back")?.addEventListener("click", () => {
  // `history.back()` rather than a link: the employee arrived here from wherever they
  // were, and that is the place to return them to.
  window.history.back();
});

// Re-asks the agent rather than reloading the address — reloading a restricted address
// would only produce this page again, which is the dead end the design forbids. What
// this does answer is "has the policy changed since I asked?", which is the question
// somebody who has just emailed their administrator actually has.
document.getElementById("recheck")?.addEventListener("click", () => {
  void paint();
});

void paint();
