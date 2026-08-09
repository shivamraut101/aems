// AEMS BRIDGE PROTOCOL — the browser extension's copy.
//
// `apps/desktop-agent/src/main/bridge-protocol.ts` holds the other copy, and everything
// below the marker line is byte-identical between the two. The agent's
// `bridge-protocol.test.ts` reads both files and fails if they ever drift.
//
// Do not add an import here. This file is compiled by tsc into an MV3 service worker
// and by electron-vite into the agent's main process, and neither build can reach the
// other's module graph.
// === SHARED PROTOCOL — byte-identical in both copies below this line ===
/**
 * What the managed browser extension and the agent say to each other.
 *
 * The transport is Chrome native messaging: the extension calls
 * `chrome.runtime.connectNative`, Chrome spawns the agent's own binary in bridge mode,
 * and the two exchange length-prefixed JSON over that child's stdio.
 *
 * A 127.0.0.1 listener was rejected for this. Any local process could POST fabricated
 * activity to it under the device token, and a hostile process that grabbed the port
 * first would harvest every URL the employee visits. Native messaging inverts that:
 * only a browser Chrome itself trusts can start the channel, the manifest names the
 * exact extension ids allowed to use it, and nothing is listening when no browser is.
 *
 * Both directions are validated at the far end. The extension is the least trusted
 * input the agent has — it runs inside a browser rendering the open web — so
 * `isExtensionMessage` is the gate every inbound frame passes before anything reads a
 * field off it.
 */

/** Bumped only for an incompatible change. A mismatch is refused, never coerced. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * The native messaging host id, and therefore the registry key and manifest filename.
 *
 * Reverse-DNS because that is what Chrome's own documentation requires; it must match
 * `chrome.runtime.connectNative(NATIVE_HOST_NAME)` in the extension exactly.
 */
export const NATIVE_HOST_NAME = "com.aems.agent.bridge";

/**
 * Extension ids allowed to open the channel, listed in the host manifest's
 * `allowed_origins`.
 *
 * This id is pinned by the `key` field in the extension manifest — a committed RSA
 * public key whose SHA-256 Chrome maps to exactly these 32 characters. Without it the
 * id of an unpacked extension is derived from its install path, so it would differ on
 * every machine and no manifest could name it.
 *
 * `extension-id.test.ts` derives the id from the committed public key and asserts it
 * equals this constant, so the two can never be edited apart.
 */
export const AEMS_EXTENSION_IDS: readonly string[] = ["eofbpabfaedpbfaemggelkjhlcaagaii"];

/**
 * Ceiling on one inbound frame.
 *
 * Chrome's own limit is 1 MB extension → host. Nothing this protocol carries is even
 * close to 64 KB, and an unbounded length prefix read from a browser process is a
 * trivial way to make the agent allocate until it dies.
 */
export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024;

/** One restricted site. `id` is stable so the browser can diff its own rule set. */
export interface WebsiteRule {
  id: number;
  /** Host, matched on the host itself and on its subdomains. Never a full URL. */
  domain: string;
  /** Why, in the employee's language. Shown on the page that replaces the site. */
  reason: string | null;
}

/** The policy in force, quoted on the blocked page so it names its own authority. */
export interface BridgePolicy {
  version: string;
  name: string;
}

/**
 * Why the agent is or is not collecting.
 *
 * The extension reports nothing unless this is `collecting` — the same consent gate
 * the agent applies to itself (non-negotiable #1), applied one process further out.
 */
export type MonitoringState = "collecting" | "not-enrolled" | "consent-required" | "revoked";

/** Host → extension: everything the extension needs to behave correctly. */
export interface BridgeStateMessage {
  v: number;
  type: "state";
  monitoring: MonitoringState;
  policy: BridgePolicy | null;
  rules: WebsiteRule[];
  /**
   * Who to ask about a blocked page — a name, a team, an address.
   *
   * Null renders as a generic line rather than being omitted: `docs/design.md` rules
   * out a dead-end "blocked" screen, so the page always says who can change this.
   */
  contact: string | null;
  /**
   * Whether an address this extension reports would in fact be recorded.
   *
   * Deliberately not folded into `monitoring`, because the two answer different
   * questions and only one of them is about consent. When an administrator switches a
   * device's `websites` scope off, everything else on that machine keeps being
   * collected — so `monitoring` stays `collecting` — and the host silently drops every
   * address it is handed. Without this field the extension goes on transmitting URLs
   * for no permitted purpose, under a popup that tells the employee they are recorded.
   *
   * Optional: a host that does not send it is read as permitting, the same fail-open
   * direction an absent collection scope already has on the host side.
   */
  websites?: boolean;
}

export interface BridgeErrorMessage {
  v: number;
  type: "error";
  message: string;
}

export type HostMessage = BridgeStateMessage | BridgeErrorMessage;

/** Extension → host, sent once when the channel opens. */
export interface HelloMessage {
  v: number;
  type: "hello";
  extensionVersion: string;
  /**
   * Which browser this is — "Chrome", "Edge" — and nothing narrower.
   *
   * The extension id is pinned by the manifest's `key`, so every Chromium browser that
   * loads this extension hands the host the *same* `chrome-extension://` origin on its
   * command line. Without this the agent's link file collapses two connected browsers
   * into one entry they take turns overwriting, and the dashboard cannot answer the one
   * question a duplicate install raises: how many browsers on this machine are
   * reporting. Every profile of the same browser sends the same string, nothing is
   * recorded or refused on the strength of it, and an extension that omits it is served
   * exactly as before.
   */
  browser?: string;
}

/**
 * The address of the page the employee is looking at.
 *
 * The full URL rather than a host: the agent reduces it to a domain with the same
 * `extractDomain` every other observation goes through, so one rule decides what a
 * "website" is no matter which watcher saw it.
 */
export interface PageMessage {
  v: number;
  type: "page";
  url: string;
  at: string;
}

/** No browser window holds a page any more — the tab closed, or the browser lost focus. */
export interface ClearedMessage {
  v: number;
  type: "cleared";
  at: string;
}

/** A navigation the extension refused. Recorded so enforcement is auditable. */
export interface BlockedMessage {
  v: number;
  type: "blocked";
  url: string;
  ruleId: number;
  at: string;
}

export type ExtensionMessage = HelloMessage | PageMessage | ClearedMessage | BlockedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStamp(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 40;
}

/**
 * The gate every inbound frame passes.
 *
 * Structural rather than a schema library, because this file is compiled by two
 * toolchains and must not carry a dependency. It rejects rather than coerces: a frame
 * the agent cannot vouch for is dropped, and dropping one page report costs an
 * interval of website attribution, whereas trusting a malformed one puts an
 * unvalidated string into somebody's activity record.
 */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value)) return false;
  if (value["v"] !== BRIDGE_PROTOCOL_VERSION) return false;

  switch (value["type"]) {
    case "hello":
      return (
        typeof value["extensionVersion"] === "string" &&
        value["extensionVersion"].length <= 20 &&
        // `isStamp`'s 40 characters is a browser name with room to spare, and refuses
        // anything trying to be a payload rather than a label.
        (value["browser"] === undefined || isStamp(value["browser"]))
      );
    case "page":
      // 2048 is the address-bar length every browser agrees on; nothing longer is a
      // page anybody navigated to on purpose.
      return (
        typeof value["url"] === "string" &&
        value["url"].length > 0 &&
        value["url"].length <= 2048 &&
        isStamp(value["at"])
      );
    case "cleared":
      return isStamp(value["at"]);
    case "blocked":
      return (
        typeof value["url"] === "string" &&
        value["url"].length <= 2048 &&
        typeof value["ruleId"] === "number" &&
        isStamp(value["at"])
      );
    default:
      return false;
  }
}

/** The extension's own gate on what the host sends it. Same argument, other direction. */
export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value)) return false;
  if (value["v"] !== BRIDGE_PROTOCOL_VERSION) return false;

  if (value["type"] === "error") return typeof value["message"] === "string";
  if (value["type"] !== "state") return false;

  const monitoring = value["monitoring"];
  const known =
    monitoring === "collecting" ||
    monitoring === "not-enrolled" ||
    monitoring === "consent-required" ||
    monitoring === "revoked";

  return (
    known &&
    (value["websites"] === undefined || typeof value["websites"] === "boolean") &&
    Array.isArray(value["rules"]) &&
    value["rules"].every(isWebsiteRule)
  );
}

export function isWebsiteRule(value: unknown): value is WebsiteRule {
  if (!isRecord(value)) return false;

  return (
    typeof value["id"] === "number" &&
    Number.isInteger(value["id"]) &&
    value["id"] > 0 &&
    typeof value["domain"] === "string" &&
    value["domain"].length > 0 &&
    value["domain"].length <= 253 &&
    (value["reason"] === null || typeof value["reason"] === "string")
  );
}
