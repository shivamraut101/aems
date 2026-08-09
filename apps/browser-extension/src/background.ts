/**
 * The service worker: the browser's half of the AEMS bridge.
 *
 * It does exactly two things. It tells the agent which site is in the focused tab, and
 * it applies the website rules the agent hands back. It has no network code, no remote
 * endpoint, no content script and no storage — the only thing it can talk to is the
 * agent on this machine, over a native messaging port Chrome will not open unless the
 * agent's host manifest names this extension by id.
 *
 * # Why a native messaging port rather than a local HTTP call
 *
 * A 127.0.0.1 listener in the agent was rejected at design review. Any local process
 * could POST fabricated activity to it under the device token, and a hostile process
 * that grabbed the port first would harvest every URL the employee visits. Native
 * messaging inverts both: Chrome starts the host, the host manifest pins which
 * extensions may reach it, and nothing is listening when no browser is running.
 *
 * # The service worker lifetime
 *
 * MV3 stops this worker when it is idle, so nothing here may assume it has been running
 * since the browser started. Every entry point calls {@link ensureConnected} first, and
 * all state is rebuilt from the agent's answer rather than remembered — which is also
 * why the agent replies with the full state to every message rather than only the
 * first.
 */

import {
  browserLabel,
  connectionView,
  mayEnforce,
  mayReport,
  reportableUrl,
  toDynamicRules,
} from "./core.js";
import type { ConnectionView } from "./core.js";
import { BLOCKED_PAGE } from "./manifest.js";
import type { BridgeStateMessage, ExtensionMessage, WebsiteRule } from "./protocol.js";
import { BRIDGE_PROTOCOL_VERSION, isHostMessage, NATIVE_HOST_NAME } from "./protocol.js";

let port: chrome.runtime.Port | null = null;
let state: BridgeStateMessage | null = null;
/** Why the last connection attempt failed, verbatim, so the popup can quote it. */
let lastError: string | null = null;
/** The last address handed to the agent, so an unchanged tab is not re-reported every event. */
let lastReported: string | null = null;
/**
 * Whether any window of *this* browser profile currently has focus.
 *
 * `chrome.tabs.query({ lastFocusedWindow: true })` answers per profile, so a Chrome
 * window sitting behind the one the employee is typing in would happily report its own
 * tab on every repeat — and the agent takes the freshest report, so the background
 * profile would win. Optimistic at worker start because a worker almost always wakes on
 * activity in its own profile, and the first focus event corrects it either way.
 */
let focused = true;

/**
 * Opens the port if it is not already open.
 *
 * `connectNative` throws synchronously when the host manifest is missing, and it is
 * this failure — a rollout where the agent never registered itself — that the extension
 * must report rather than degrade past. The error is kept, not swallowed.
 */
function ensureConnected(): void {
  if (port !== null) return;

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (error) {
    port = null;
    state = null;
    lastError = describe(error);
    return;
  }

  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    // Chrome reports why here and nowhere else: "Specified native messaging host not
    // found" is the un-registered agent, and it must reach the employee's readout.
    lastError = chrome.runtime.lastError?.message ?? "The AEMS agent closed the connection";
    port = null;
    state = null;
    lastReported = null;
  });

  lastError = null;
  send({
    v: BRIDGE_PROTOCOL_VERSION,
    type: "hello",
    extensionVersion: chrome.runtime.getManifest().version,
    // A property read, so this function stays synchronous and none of its five call
    // sites has to race the popup's answer deadline.
    browser: browserLabel(navigator.userAgent),
  });
}

function send(message: ExtensionMessage): void {
  try {
    port?.postMessage(message);
  } catch (error) {
    // The agent quit between the check and the write. Dropping the port makes the next
    // event reconnect; keeping it would leave every later report failing silently.
    lastError = describe(error);
    port = null;
    state = null;
  }
}

function onHostMessage(message: unknown): void {
  // The agent is trusted more than the open web, but it is still another process on a
  // machine the employee administers. A frame that is not the shape this protocol
  // describes is discarded rather than read field by field.
  if (!isHostMessage(message)) {
    lastError = "The AEMS agent and this extension disagree on the protocol";
    return;
  }

  if (message.type === "error") {
    lastError = message.message;
    return;
  }

  state = message;
  lastError = null;
  void applyRules(message);
}

// -- restriction ----------------------------------------------------------

/**
 * Replaces the dynamic rule set with the one the policy in force describes.
 *
 * Dynamic rules survive a browser restart and a service-worker shutdown, which is what
 * makes them the right mechanism — and also what makes it essential that the set is
 * *replaced* rather than added to. A rule an administrator removed must stop blocking
 * the moment the policy says so, and a device that has been revoked must not be left
 * enforcing a policy nobody can point at any more.
 */
async function applyRules(message: BridgeStateMessage): Promise<void> {
  const wanted: readonly WebsiteRule[] = mayEnforce(message.monitoring) ? message.rules : [];
  const next = toDynamicRules(wanted, BLOCKED_PAGE);

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((rule) => rule.id);

    if (removeRuleIds.length === 0 && next.length === 0) return;

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: next });
  } catch (error) {
    // Reported through the popup rather than only to the console: an employee who is
    // being blocked, or who is not being blocked when the policy says they should be,
    // has no other way to discover that the rules failed to apply.
    lastError = `The website rules could not be applied (${describe(error)})`;
  }
}

// -- reporting ------------------------------------------------------------

/** Reports whatever the focused window's active tab is showing, or that it is showing nothing. */
async function reportActiveTab(again = false): Promise<void> {
  ensureConnected();
  if (port === null) return;

  let url: string | null = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    url = reportableUrl(tab?.url);
  } catch {
    // A window closing under the query. Reporting nothing is the honest answer, and it
    // is also what stops the previous site accruing time it did not.
    url = null;
  }

  publish(url, again);
}

/**
 * Hands one observation to the agent.
 *
 * The consent gate is applied here rather than at each call site, so there is exactly
 * one place in this file where a URL can leave the browser. `cleared` is sent even when
 * reporting is off, because it withdraws a claim rather than making one — an extension
 * that goes quiet on a withdrawal would leave the agent attributing time to the last
 * site it heard about.
 *
 * `again` re-sends an address the agent has already been told about. It is what makes a
 * page held in view for an hour count for an hour: the agent believes an observation for
 * a bounded window and then stops attributing it, because a URL that outlived its
 * browser would go on collecting somebody's time. Without the repeat, only navigations
 * were ever recorded and a ten-minute read counted as seconds.
 */
function publish(url: string | null, again = false): void {
  const at = new Date().toISOString();

  if (url === null) {
    if (lastReported === null) return;
    lastReported = null;
    send({ v: BRIDGE_PROTOCOL_VERSION, type: "cleared", at });
    return;
  }

  if (!mayReport(state)) return;
  if (url === lastReported && !again) return;

  lastReported = url;
  send({ v: BRIDGE_PROTOCOL_VERSION, type: "page", url, at });
}

// -- events ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void reportActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  void reportActiveTab();
});

chrome.tabs.onActivated.addListener(() => {
  void reportActiveTab();
});

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  // Only a committed address change in the tab the employee is looking at. Firing on
  // every `status` transition would report the same page three times per navigation.
  if (change.url === undefined || !tab.active) return;
  void reportActiveTab();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  // The browser lost focus to another application. Saying so is what keeps two browsers
  // — or a browser and an editor — from both claiming the same minute: the agent takes
  // the freshest report, and a browser that is not in front reports nothing in view.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    focused = false;
    ensureConnected();
    publish(null);
    return;
  }

  focused = true;
  void reportActiveTab();
});

/**
 * How often the address in view is re-sent.
 *
 * Comfortably inside the agent's observation window, so one dropped repeat costs no
 * attribution, and inside Chrome's own service-worker idle timer — each repeat is a
 * message on the native port and the agent answers every one, which is what keeps the
 * worker alive to send the next. A browser doing nothing therefore holds the channel
 * open; that is the point, because the alternative is a worker that sleeps through the
 * hour somebody spends reading one page.
 */
const REPEAT_MS = 20_000;

setInterval(() => {
  if (!focused) return;
  void reportActiveTab(true);
}, REPEAT_MS);

// -- the pages ------------------------------------------------------------

/** What the popup and the blocked page ask for. Neither can reach the agent directly. */
interface PageQuery {
  type: "aems:state";
  ruleId?: number;
}

export interface PageAnswer {
  connection: ConnectionView;
  monitoring: BridgeStateMessage["monitoring"] | null;
  policy: BridgeStateMessage["policy"];
  contact: string | null;
  restrictedCount: number;
  rule: WebsiteRule | null;
  /** Null is "the agent did not say", which the pages read as permitting, as the host does. */
  websites: boolean | null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPageQuery(message)) return undefined;

  ensureConnected();

  // The port answers asynchronously and the worker may have only just woken, so the
  // reply is deferred by a tick rather than sent from stale state. `true` keeps the
  // message channel open across that await, which is the one MV3 detail that silently
  // breaks a popup if it is left out.
  setTimeout(() => {
    const ruleId = message.ruleId;

    if (ruleId !== undefined && state !== null && mayEnforce(state.monitoring)) {
      // Recorded so enforcement is auditable. The rule's domain rather than the full
      // address: `requestDomains` matching never hands the original URL to the redirect
      // target, and inventing one would be worse than naming the rule that fired.
      const rule = state.rules.find((candidate) => candidate.id === ruleId);
      if (rule !== undefined) {
        send({
          v: BRIDGE_PROTOCOL_VERSION,
          type: "blocked",
          url: rule.domain,
          ruleId,
          at: new Date().toISOString(),
        });
      }
    }

    sendResponse(answerFor(ruleId));
  }, PAGE_ANSWER_DELAY_MS);

  return true;
});

/**
 * Long enough for a just-woken worker's port to have received the agent's opening state
 * frame, short enough that the popup does not read as broken. The agent sends that
 * frame before it reads anything, so this is a local pipe round trip, not a network one.
 */
const PAGE_ANSWER_DELAY_MS = 120;

export function answerFor(ruleId: number | undefined): PageAnswer {
  return {
    connection: connectionView(state, lastError),
    monitoring: state?.monitoring ?? null,
    policy: state?.policy ?? null,
    contact: state?.contact ?? null,
    restrictedCount: state === null || !mayEnforce(state.monitoring) ? 0 : state.rules.length,
    rule:
      ruleId === undefined ? null : (state?.rules.find((rule) => rule.id === ruleId) ?? null),
    websites: state?.websites ?? null,
  };
}

function isPageQuery(message: unknown): message is PageQuery {
  if (typeof message !== "object" || message === null) return false;

  const record = message as Record<string, unknown>;
  if (record["type"] !== "aems:state") return false;

  const ruleId = record["ruleId"];
  return ruleId === undefined || (typeof ruleId === "number" && Number.isInteger(ruleId));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The worker may be started by an event that is not one of the listeners above — a
// popup opening, for instance. Reporting on load costs one local pipe and means the
// state is already in hand when something asks for it. It reports rather than merely
// connecting because `hello` tells the agent this browser has nothing in view: a worker
// Chrome recycled mid-page would otherwise clear the address and never resend it, since
// nothing else fires until the employee changes tab.
void reportActiveTab();
