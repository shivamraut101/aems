/**
 * The agent, re-entered as a Chrome native messaging host.
 *
 * On Windows there is no supported way to read a browser's address bar from outside
 * the browser, which is why the managed extension exists at all — and the mechanism
 * that reports a URL is the mechanism that can refuse one. This module is the agent's
 * half of that channel.
 *
 * # The single-instance trap
 *
 * `index.ts` calls `app.requestSingleInstanceLock()` at module scope. Chrome starts a
 * *new* process for every native messaging port, so a bridge that reached that call
 * would find the lock already held by the running agent, take the `else` branch and
 * `app.quit()` before writing a single byte — and the extension would see a channel
 * that connects and instantly disconnects, forever, with nothing in any log. Worse,
 * asking for the lock at all fires `second-instance` in the running agent, whose
 * handler opens the agent window: every browser launch would pop a window in the
 * employee's face.
 *
 * So {@link readBridgeInvocation} is consulted *before* the lock is ever requested,
 * and the bridge branch never requests it. See the tail of `index.ts`.
 *
 * # stdout is the wire
 *
 * Everything this process writes to stdout is a protocol frame. One stray
 * `console.log` anywhere in the main process would corrupt the stream and Chrome would
 * drop the port. All logging here goes to stderr, which Chrome captures separately.
 */

import type { AgentPolicy, DataTypeId } from "../shared/types/index.js";
import type {
  BridgeStateMessage,
  ExtensionMessage,
  HostMessage,
  MonitoringState,
  WebsiteRule,
} from "./bridge-protocol.js";
import {
  AEMS_EXTENSION_IDS,
  BRIDGE_PROTOCOL_VERSION,
  isExtensionMessage,
  isWebsiteRule,
  MAX_BRIDGE_MESSAGE_BYTES,
} from "./bridge-protocol.js";

/** How Chrome names the extension on the host's command line: `chrome-extension://<id>/`. */
const ORIGIN_ARGUMENT = /^chrome-extension:\/\/([a-p]{32})\/?$/;

/**
 * An explicit opt-in, for a launcher that does not put the origin on the command line.
 *
 * Also what the repository's own bridge check uses, so the branch can be exercised
 * without a browser.
 */
export const BRIDGE_FLAG = "--aems-native-bridge";

/**
 * How the launcher hands the Node-mode host Electron's `userData` directory.
 *
 * Lives here rather than beside the host entry because that entry is a *program* — it
 * serves a channel the moment it is loaded — so nothing may import it to read a
 * constant. Reproducing `app.getPath("userData")` in Node instead of being told it
 * would mean restating Electron's own rules for where an app's data lives, and the copy
 * that got it wrong would read an empty config, report the machine as not enrolled, and
 * look exactly like a consent problem.
 */
export const USER_DATA_FLAG = "--aems-user-data";

export function readUserDataPath(argv: readonly string[]): string | null {
  const index = argv.indexOf(USER_DATA_FLAG);
  const value = index < 0 ? undefined : argv[index + 1];

  return value !== undefined && value.length > 0 ? value : null;
}

export interface BridgeInvocation {
  /** `chrome-extension://<id>/`, or null when the flag was used without one. */
  origin: string | null;
  extensionId: string | null;
}

/**
 * Whether this process was started as a native messaging host.
 *
 * Must be answerable from `process.argv` alone, with no Electron call and no I/O,
 * because it is consulted before anything else in the program runs.
 */
export function readBridgeInvocation(argv: readonly string[]): BridgeInvocation | null {
  let flagged = false;

  for (const argument of argv) {
    if (argument === BRIDGE_FLAG) {
      flagged = true;
      continue;
    }

    const match = ORIGIN_ARGUMENT.exec(argument);
    if (match?.[1] !== undefined) {
      return { origin: `chrome-extension://${match[1]}/`, extensionId: match[1] };
    }
  }

  return flagged ? { origin: null, extensionId: null } : null;
}

/**
 * Whether Chrome handed us an extension the host manifest actually names.
 *
 * Chrome enforces `allowed_origins` itself, so this is defence in depth — against a
 * manifest someone widened by hand, and against a launcher that is not Chrome.
 */
export function isAllowedExtension(
  extensionId: string | null,
  allowed: readonly string[] = AEMS_EXTENSION_IDS,
): boolean {
  return extensionId !== null && allowed.includes(extensionId);
}

// -- framing --------------------------------------------------------------

/** A stream that cannot be resynchronised. The channel is abandoned, not repaired. */
export class BridgeFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeFramingError";
  }
}

/** One message: a little-endian uint32 byte count, then that many bytes of UTF-8 JSON. */
export function encodeFrame(message: HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);

  return Buffer.concat([header, body]);
}

/**
 * Reassembles frames from a byte stream.
 *
 * A pipe delivers whatever the OS felt like: half a header, three messages in one
 * chunk, a body split across four. Decoding per chunk instead of per frame is the
 * classic way this goes wrong, and it fails intermittently under load rather than in a
 * test.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number = MAX_BRIDGE_MESSAGE_BYTES) {}

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const messages: unknown[] = [];

    for (;;) {
      if (this.buffer.length < 4) return messages;

      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        // The length prefix comes from a browser process. Trusting an unbounded one is
        // a one-line way to make the agent allocate until it dies, and once a bad
        // prefix is read there is no way to find the next frame boundary.
        throw new BridgeFramingError(`Frame of ${length} bytes exceeds the ${this.maxBytes} limit`);
      }

      if (this.buffer.length < 4 + length) return messages;

      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        // Framing survived — the boundary was correct — so only this message is lost.
        // The caller answers with a protocol error and keeps the channel.
        messages.push(undefined);
      }
    }
  }
}

// -- state ----------------------------------------------------------------

/**
 * The plaintext half of the agent's config.
 *
 * Deliberately not `AgentConfig`: this process never loads the device token. It has no
 * need for one — it hands its observation to the running agent rather than posting it
 * — and a long-lived credential decrypted inside a process a browser started is a
 * larger blast radius than the feature is worth. `deviceId` is the enrolment signal
 * instead, and it lives in the readable JSON.
 */
export interface BridgeConfigFacts {
  deviceId: string | null;
  consentedPolicyVersion: string | null;
  policy: AgentPolicy | null;
  /**
   * The device's collection scope, or null when no per-device scope has arrived.
   *
   * Read here as well as in the collection loop because this is a *separate process*
   * reading the same JSON — an administrator switching websites off has to reach the
   * browser half at the next navigation, not at the next browser restart.
   */
  collection: DataTypeId[] | null;
  revoked: boolean;
}

/**
 * Mirrors `mayCollect`, one process further out.
 *
 * The extension reports nothing unless this says `collecting`, so consent withdrawn in
 * the dashboard stops browser reporting at the employee's very next navigation
 * (non-negotiable #4) rather than whenever a browser happens to restart. Ordered
 * most-terminal first for the same reason `indicatorStateFor` is: a revoked device
 * must never be described as merely needing consent.
 */
export function monitoringStateOf(facts: BridgeConfigFacts): MonitoringState {
  if (facts.revoked) return "revoked";
  if (facts.deviceId === null) return "not-enrolled";
  if (facts.policy === null || facts.consentedPolicyVersion === null) return "consent-required";
  return facts.policy.version === facts.consentedPolicyVersion ? "collecting" : "consent-required";
}

/**
 * Whether an address reported by the browser may be recorded at all.
 *
 * Separate from {@link monitoringStateOf} rather than folded into it, and that is a
 * decision rather than an oversight. `MonitoringState` is shared byte-for-byte with the
 * extension and has no member for "collecting, but not websites"; borrowing
 * `consent-required` to mean it would make the extension's own status panel tell the
 * employee to go and accept a policy they have already accepted, and would switch off
 * the restriction rules too — which are enforcement, not observation, and are not what
 * a `websites` setting governs.
 *
 * So the refusal lands here, on the host side of the pipe, which is the process that
 * would otherwise write the address down. The gate mirrors `mayCollectType`: an absent
 * or unusable scope permits, exactly as an absent settings row does.
 */
export function mayRecordWebsites(facts: BridgeConfigFacts): boolean {
  if (monitoringStateOf(facts) !== "collecting") return false;
  return Array.isArray(facts.collection) ? facts.collection.includes("websites") : true;
}

/**
 * The restriction list carried on the policy the agent already holds.
 *
 * Read defensively off `AgentPolicy` rather than declared on it, because the field is
 * not there yet: the client's decision that website restriction is in scope landed
 * after the schema was locked, and `policies` has no column for it. The moment the API
 * adds `websiteRestrictions` to the policy payload the agent stores, this starts
 * returning rules with no further change here — and until then it returns none, which
 * is the correct fail-open for a control nobody has configured.
 *
 * Every rule is validated with the same predicate the wire protocol uses: a policy
 * document is server-controlled, but it reaches this process through a file on the
 * employee's own disk.
 */
export function websiteRestrictionsOf(policy: AgentPolicy | null): {
  rules: WebsiteRule[];
  contact: string | null;
} {
  const restrictions = (policy as { websiteRestrictions?: unknown } | null)?.websiteRestrictions;
  if (typeof restrictions !== "object" || restrictions === null) return { rules: [], contact: null };

  const { rules, contact } = restrictions as { rules?: unknown; contact?: unknown };

  return {
    rules: Array.isArray(rules) ? rules.filter(isWebsiteRule) : [],
    contact: typeof contact === "string" && contact.length > 0 ? contact : null,
  };
}

export function stateMessageOf(facts: BridgeConfigFacts): BridgeStateMessage {
  const { rules, contact } = websiteRestrictionsOf(facts.policy);

  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: "state",
    monitoring: monitoringStateOf(facts),
    policy: facts.policy === null ? null : { version: facts.policy.version, name: facts.policy.name },
    rules,
    contact,
  };
}

// -- the channel ----------------------------------------------------------

/** What one page report told the agent. `url` null means "this browser has nothing in view". */
export interface BridgeObservation {
  url: string | null;
  at: string;
  extensionVersion?: string | null;
  linked?: boolean;
}

export interface BridgePorts {
  write(frame: Buffer): void;
  /** Re-read on every message, so a config change lands without reconnecting. */
  readFacts(): BridgeConfigFacts;
  /** Hands the observation to the running agent. Never called while monitoring is off. */
  observe(observation: BridgeObservation): void;
  log(message: string, error?: unknown): void;
  close(): void;
  /**
   * The host's clock, not the browser's.
   *
   * Every stamp the agent later reasons about is taken here. A page's own idea of
   * "now" is whatever the web decided it was, and this file's job is to hand the agent
   * something it can trust.
   */
  now(): Date;
}

/**
 * Serves one extension for as long as its port is open.
 *
 * Every inbound frame is answered with the current state, not only the first: a
 * navigation is the natural moment to learn that consent was withdrawn or that a rule
 * changed, and it costs one local pipe write.
 */
export class NativeBridge {
  private readonly decoder = new FrameDecoder();

  constructor(private readonly ports: BridgePorts) {}

  /** Feeds one chunk of the browser's bytes through. Returns false once the channel is done. */
  receive(chunk: Buffer): boolean {
    let messages: unknown[];

    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.ports.log("Abandoning the browser channel", error);
      this.ports.close();
      return false;
    }

    for (const message of messages) this.handle(message);
    return true;
  }

  private handle(message: unknown): void {
    if (!isExtensionMessage(message)) {
      // Answered rather than dropped in silence: the extension's own status readout is
      // what tells an employee the channel is broken, and it can only say so if it is
      // told. Nothing is read off the frame itself.
      this.send({
        v: BRIDGE_PROTOCOL_VERSION,
        type: "error",
        message: "Unrecognised message; the browser extension and the agent disagree on the protocol",
      });
      this.ports.log("Discarded an unrecognised message from the browser extension");
      return;
    }

    this.apply(message);
  }

  private apply(message: ExtensionMessage): void {
    const facts = this.ports.readFacts();
    const state = stateMessageOf(facts);
    const collecting = state.monitoring === "collecting";
    const websites = mayRecordWebsites(facts);

    switch (message.type) {
      case "hello":
        // The link is recorded whether or not collection is on. It is a statement about
        // what this machine *can* see, which is what the consent screen needs in order
        // to promise website tracking honestly — and recording it is not collecting.
        this.ports.observe({
          url: null,
          at: this.ports.now().toISOString(),
          extensionVersion: message.extensionVersion,
          linked: true,
        });
        break;

      case "page":
        // Recorded as "nothing in view" rather than skipped when websites are off, so
        // the first navigation after the switch also clears whatever the last permitted
        // one left in the link file — otherwise a stale address would go on being
        // offered to the tracker until the browser happened to restart.
        if (collecting) {
          this.ports.observe({
            url: websites ? message.url : null,
            at: this.ports.now().toISOString(),
          });
        }
        break;

      case "cleared":
        if (collecting) this.ports.observe({ url: null, at: this.ports.now().toISOString() });
        break;

      case "blocked":
        // Enforcement, not observation. There is no event type for a refused navigation
        // yet, so it is logged where an administrator can find it rather than invented
        // into the activity stream.
        this.ports.log(`Browser policy refused ${message.url} (rule ${String(message.ruleId)})`);
        break;
    }

    this.send(state);
  }

  send(message: HostMessage): void {
    try {
      this.ports.write(encodeFrame(message));
    } catch (error) {
      // Chrome closed the port. Nothing to recover; the process exits with it.
      this.ports.log("Could not write to the browser channel", error);
      this.ports.close();
    }
  }
}
