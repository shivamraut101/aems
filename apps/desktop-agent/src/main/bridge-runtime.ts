/**
 * The bridge process, wired to real stdio and real files.
 *
 * `bridge.ts` holds the decisions — what a valid frame is, what the extension is told,
 * when an observation counts. This file is the adapter that gives those decisions a
 * stdin, a stdout and two files, and it is deliberately the only place in the bridge
 * path that touches either.
 *
 * Nothing here writes to stdout except a protocol frame. Chrome reads that pipe as the
 * wire, so a single `console.log` anywhere on this path desynchronises the stream and
 * the port dies with no diagnostic at all. Every message goes to stderr, which Chrome
 * captures separately and a support call can ask for.
 */

import type { AgentPolicy, DataTypeId } from "../shared/types/index.js";
import type { BridgeConfigFacts, BridgeInvocation, BridgePorts } from "./bridge.js";
import { isAllowedExtension, NativeBridge, stateMessageOf } from "./bridge.js";
import { AEMS_EXTENSION_IDS, BRIDGE_PROTOCOL_VERSION } from "./bridge-protocol.js";
import { BrowserLinkStore } from "./bridge-link.js";

/**
 * Reads the agent's plaintext config into the four facts the bridge reasons about.
 *
 * Only the readable JSON is opened — never `device-token.bin`. A browser can start this
 * process at any moment, and a long-lived device credential decrypted inside a process
 * a browser spawned is a much larger blast radius than a URL report is worth. `deviceId`
 * carries the enrolment signal instead, and it lives in the plaintext half.
 *
 * Defensive to the point of paranoia because a hand-edited or half-written config must
 * cost the *browser* half of tracking, never the agent: every failure here lands on
 * `not-enrolled`, which reports nothing and blocks nothing.
 */
export function readBridgeConfigFacts(raw: string | null): BridgeConfigFacts {
  const empty: BridgeConfigFacts = {
    deviceId: null,
    consentedPolicyVersion: null,
    policy: null,
    collection: null,
    revoked: false,
  };

  if (raw === null) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }

  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;

  return {
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"] : null,
    consentedPolicyVersion:
      typeof record["consentedPolicyVersion"] === "string"
        ? record["consentedPolicyVersion"]
        : null,
    policy: readPolicy(record["policy"]),
    collection: readCollection(record["collection"]),
    // Anything other than an explicit `false` is treated as revoked once the key is
    // present at all: failing closed is the only safe direction for a stop signal.
    revoked: record["revoked"] === true,
  };
}

/**
 * The device's scope, or null when the file does not carry one.
 *
 * Deliberately not checked against the known vocabulary: this file is compiled into the
 * bridge entry, which a browser spawns, and a value import of the type package to
 * validate a list that can only ever *narrow* what is recorded would be weight for
 * nothing. An unrecognised member is simply not `"websites"`.
 */
function readCollection(value: unknown): DataTypeId[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is DataTypeId => typeof entry === "string");
}

/**
 * Keeps the whole policy object, not a rebuilt copy of the fields named here.
 *
 * `websiteRestrictionsOf` reads a field the schema does not carry yet, so rebuilding
 * the policy from a known field list would silently drop the restriction rules on the
 * day the API starts sending them — a bug that would look like "blocking does not
 * work" and point at the extension.
 */
function readPolicy(value: unknown): AgentPolicy | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  if (typeof record["version"] !== "string" || typeof record["name"] !== "string") return null;

  return value as AgentPolicy;
}

/** Everything the bridge process reads or writes outside itself. */
export interface BridgeRuntimeDeps {
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: Buffer): unknown };
  /** Reads the agent's plaintext config. Null when the machine has never enrolled. */
  readConfig(): string | null;
  /** Where a page report is left for the running agent to pick up. */
  link: BrowserLinkStore;
  log(message: string, error?: unknown): void;
  now(): Date;
  exit(code: number): void;
  allowedExtensionIds?: readonly string[];
}

/**
 * Serves one native messaging port until the browser closes it.
 *
 * Returns the bridge so a caller — and the test suite — can drive frames through it
 * without a real pipe.
 */
export function startBridge(
  invocation: BridgeInvocation,
  deps: BridgeRuntimeDeps,
): NativeBridge | null {
  const allowed = deps.allowedExtensionIds ?? AEMS_EXTENSION_IDS;

  // Chrome enforces `allowed_origins` before it ever spawns us, so reaching here with
  // an unknown id means either a widened manifest or a launcher that is not Chrome.
  // Refusing costs a browser nothing and is the only response that keeps the manifest's
  // id list meaningful.
  if (invocation.extensionId !== null && !isAllowedExtension(invocation.extensionId, allowed)) {
    deps.log(`Refusing a browser channel from an unrecognised extension (${invocation.extensionId})`);
    deps.exit(1);
    return null;
  }

  // A flag-only invocation is the repository's own check of this branch. It speaks the
  // protocol so the channel is provable without a browser, and it deliberately records
  // nothing: the file it would write is read by the collection loop, and a self-test
  // that could put a domain into somebody's activity record is not a self-test.
  const selfTest = invocation.origin === null;
  const origin = invocation.origin;

  // The extension id is pinned, so every Chromium browser hands this host the same
  // origin — keying the link file by it collapses Chrome and Edge into one entry that
  // they take turns overwriting. The browser names itself on hello, once per port, and
  // every later frame on this port belongs to it.
  let key = origin ?? "";

  // The last address this port put in the file, so a "nothing in view" from this browser
  // cannot wipe an address a different one put there.
  //
  // Two profiles of the same browser share a key — deliberately, since attribution is
  // profile-agnostic everywhere else in the product — but they are two host processes,
  // and the background profile emits `cleared` the moment its own windows lose focus.
  // Without this it clears the focused profile's URL, and the focused profile will not
  // resend, because as far as its service worker knows nothing has changed.
  let reported: string | null = null;

  const ports: BridgePorts = {
    write: (frame) => {
      deps.stdout.write(frame);
    },

    // Re-read per message rather than captured once. Consent withdrawn in the dashboard
    // reaches the agent's config within a tick, and a browser channel that had cached
    // the old answer would keep reporting until the browser was restarted — which is
    // exactly the "revocation is immediate" guarantee failing quietly.
    readFacts: () => readBridgeConfigFacts(deps.readConfig()),

    observe: (observation) => {
      if (selfTest || origin === null) return;
      if (observation.browser != null && observation.browser.length > 0) key = observation.browser;

      if (observation.linked === true) {
        reported = null;
      } else if (observation.url === null) {
        const held = deps.link.read().browsers[key]?.url ?? null;
        // Somebody else's address is in the slot. Only its own author knows when it stops
        // being in view, and taking it away here would leave that browser unattributed
        // until the employee happened to navigate. A page report is *not* guarded this
        // way — the freshest navigation is the best evidence of what is in front.
        if (held !== null && held !== reported) return;
        reported = null;
      } else {
        reported = observation.url;
      }

      deps.link.update(
        key,
        observation.linked === true
          ? {
              origin,
              linkedAt: observation.at,
              observedAt: observation.at,
              // A reconnect means no page has been reported yet on this port. Leaving
              // the previous URL in place would let a browser that was closed on a site
              // go on claiming it the moment it reopens.
              url: null,
              extensionVersion: observation.extensionVersion ?? null,
            }
          : { origin, url: observation.url, observedAt: observation.at },
      );
    },

    log: deps.log,

    close: () => {
      deps.exit(0);
    },

    now: deps.now,
  };

  const bridge = new NativeBridge(ports);

  deps.stdin.on("data", (chunk: Buffer | string) => {
    bridge.receive(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });

  // Chrome closing the port is the ordinary end of this process's life, not a fault.
  deps.stdin.on("end", () => {
    deps.exit(0);
  });
  deps.stdin.on("error", (error: unknown) => {
    deps.log("The browser closed the channel", error);
    deps.exit(0);
  });

  // The extension is told the state before it asks. Its own readout is what tells an
  // employee whether the bridge is live, and a channel that says nothing until spoken
  // to is indistinguishable from one that never opened.
  bridge.send(stateMessageOf(ports.readFacts()));

  deps.log(
    selfTest
      ? `Browser bridge started in self-test mode (protocol v${String(BRIDGE_PROTOCOL_VERSION)}); nothing will be recorded`
      : `Browser bridge open for ${origin ?? "an unknown origin"}`,
  );

  return bridge;
}
