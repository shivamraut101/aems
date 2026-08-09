import { describe, expect, it, vi } from "vitest";

import type { AgentPolicy } from "../shared/types/index.js";
import type { BridgeConfigFacts, BridgeObservation, BridgePorts } from "./bridge.js";
import {
  BRIDGE_FLAG,
  BridgeFramingError,
  encodeFrame,
  FrameDecoder,
  isAllowedExtension,
  mayRecordWebsites,
  monitoringStateOf,
  NativeBridge,
  readBridgeInvocation,
  stateMessageOf,
  websiteRestrictionsOf,
} from "./bridge.js";
import { BRIDGE_PROTOCOL_VERSION, MAX_BRIDGE_MESSAGE_BYTES } from "./bridge-protocol.js";

const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";

function policy(patch: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    version: "2026.08.01",
    name: "Standard monitoring policy",
    screenshotIntervalSeconds: 600,
    idleThresholdSeconds: 120,
    trackedCategories: [],
    ...patch,
  };
}

function facts(patch: Partial<BridgeConfigFacts> = {}): BridgeConfigFacts {
  return {
    deviceId: "device-1",
    consentedPolicyVersion: "2026.08.01",
    policy: policy(),
    collection: null,
    revoked: false,
    ...patch,
  };
}

describe("readBridgeInvocation", () => {
  it("recognises the origin Chrome appends to the host's command line", () => {
    const invocation = readBridgeInvocation([
      "C:/Program Files/AEMS/AEMS Agent.exe",
      "C:/Users/x/AppData/Roaming/aems/com.aems.agent.bridge.json",
      `chrome-extension://${EXTENSION}/`,
    ]);

    expect(invocation).toEqual({ origin: `chrome-extension://${EXTENSION}/`, extensionId: EXTENSION });
  });

  it("accepts the origin without its trailing slash", () => {
    expect(readBridgeInvocation([`chrome-extension://${EXTENSION}`])?.extensionId).toBe(EXTENSION);
  });

  it("answers null for an ordinary agent launch, so the single-instance lock is still taken", () => {
    expect(readBridgeInvocation(["AEMS Agent.exe"])).toBeNull();
    expect(readBridgeInvocation(["AEMS Agent.exe", "--hidden"])).toBeNull();
  });

  it("answers a flagged invocation with no origin, which is the repository's own check", () => {
    expect(readBridgeInvocation(["electron", ".", BRIDGE_FLAG])).toEqual({
      origin: null,
      extensionId: null,
    });
  });

  it("refuses an id that is not 32 letters in Chrome's a-p alphabet", () => {
    // Chrome maps a hex digest onto a-p, so a z or a digit cannot be a real id — and a
    // path-shaped argument must never be read as one.
    expect(readBridgeInvocation(["chrome-extension://zzzz/"])).toBeNull();
    expect(readBridgeInvocation(["chrome-extension://abc123/"])).toBeNull();
  });
});

describe("isAllowedExtension", () => {
  it("admits only ids the host manifest names", () => {
    expect(isAllowedExtension(EXTENSION, [EXTENSION])).toBe(true);
    expect(isAllowedExtension("ponmlkjihgfedcbaponmlkjihgfedcba", [EXTENSION])).toBe(false);
    expect(isAllowedExtension(null, [EXTENSION])).toBe(false);
  });
});

describe("framing", () => {
  it("writes a little-endian uint32 length ahead of the UTF-8 body", () => {
    const frame = encodeFrame({ v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "no" });
    const body = frame.subarray(4).toString("utf8");

    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(body, "utf8"));
    expect(JSON.parse(body)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "no" });
  });

  it("reassembles a message split across chunks, which is what a pipe actually delivers", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "split" });

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 7))).toEqual([]);
    expect(decoder.push(frame.subarray(7))).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "split" },
    ]);
  });

  it("returns every message when several arrive in one chunk", () => {
    const decoder = new FrameDecoder();
    const one = encodeFrame({ v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "a" });
    const two = encodeFrame({ v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "b" });

    expect(decoder.push(Buffer.concat([one, two]))).toHaveLength(2);
  });

  it("yields undefined for a body that will not parse, keeping the boundary", () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);

    const messages = decoder.push(Buffer.concat([header, body]));

    expect(messages).toEqual([undefined]);
  });

  it("refuses a length prefix past the ceiling rather than allocating for it", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_BRIDGE_MESSAGE_BYTES + 1, 0);

    expect(() => decoder.push(header)).toThrow(BridgeFramingError);
  });
});

describe("monitoringStateOf", () => {
  it("reports collecting only when consent matches the policy in force", () => {
    expect(monitoringStateOf(facts())).toBe("collecting");
  });

  it("ranks revocation above every other reason, so a revoked device is never offered re-consent", () => {
    expect(monitoringStateOf(facts({ revoked: true }))).toBe("revoked");
    expect(monitoringStateOf(facts({ revoked: true, deviceId: null }))).toBe("revoked");
  });

  it("reports not-enrolled before consent, because there is nothing to consent to", () => {
    expect(monitoringStateOf(facts({ deviceId: null }))).toBe("not-enrolled");
  });

  it("treats a policy bump as consent lapsing", () => {
    expect(monitoringStateOf(facts({ consentedPolicyVersion: "2026.07.01" }))).toBe(
      "consent-required",
    );
    expect(monitoringStateOf(facts({ consentedPolicyVersion: null }))).toBe("consent-required");
    expect(monitoringStateOf(facts({ policy: null }))).toBe("consent-required");
  });
});

describe("websiteRestrictionsOf", () => {
  it("returns nothing for a policy that carries no restrictions, which is today's schema", () => {
    expect(websiteRestrictionsOf(policy())).toEqual({ rules: [], contact: null });
    expect(websiteRestrictionsOf(null)).toEqual({ rules: [], contact: null });
  });

  it("reads the rules and the contact once the API starts sending them", () => {
    const withRules = {
      ...policy(),
      websiteRestrictions: {
        rules: [{ id: 4, domain: "example.com", reason: "Not work related" }],
        contact: "it-support@acme.test",
      },
    } as unknown as AgentPolicy;

    expect(websiteRestrictionsOf(withRules)).toEqual({
      rules: [{ id: 4, domain: "example.com", reason: "Not work related" }],
      contact: "it-support@acme.test",
    });
  });

  it("drops a malformed rule rather than passing it to the browser", () => {
    const withRules = {
      ...policy(),
      websiteRestrictions: {
        rules: [
          { id: 0, domain: "zero-id.test", reason: null },
          { id: 5, domain: "", reason: null },
          { id: 6, domain: "ok.test", reason: null },
          "not-an-object",
        ],
        contact: "",
      },
    } as unknown as AgentPolicy;

    expect(websiteRestrictionsOf(withRules)).toEqual({
      rules: [{ id: 6, domain: "ok.test", reason: null }],
      contact: null,
    });
  });
});

describe("stateMessageOf", () => {
  it("quotes the policy so the blocked page can name its own authority", () => {
    expect(stateMessageOf(facts())).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: "state",
      monitoring: "collecting",
      policy: { version: "2026.08.01", name: "Standard monitoring policy" },
      rules: [],
      contact: null,
      websites: true,
    });
  });

  /**
   * The field exists so the extension can stop sending, and so its popup can stop saying
   * addresses are recorded when the host is dropping every one of them. Both are decided
   * from this one boolean, so it has to follow the scope rather than the consent gate.
   */
  it("tells the extension when the device's website scope is off, without changing monitoring", () => {
    const message = stateMessageOf(facts({ collection: ["applications", "idle"] }));

    expect(message.monitoring).toBe("collecting");
    expect(message.websites).toBe(false);
  });
});

interface Harness {
  bridge: NativeBridge;
  ports: BridgePorts;
  sent: unknown[];
  observed: BridgeObservation[];
  logs: string[];
  closed: () => number;
}

function harness(current: BridgeConfigFacts = facts()): Harness {
  const sent: unknown[] = [];
  const observed: BridgeObservation[] = [];
  const logs: string[] = [];
  let closes = 0;
  const decoder = new FrameDecoder();

  const ports: BridgePorts = {
    write: (frame) => {
      for (const message of decoder.push(frame)) sent.push(message);
    },
    readFacts: () => current,
    observe: (observation) => observed.push(observation),
    log: (message) => logs.push(message),
    close: () => {
      closes += 1;
    },
    now: () => new Date("2026-08-05T09:00:00.000Z"),
  };

  return { bridge: new NativeBridge(ports), ports, sent, observed, logs, closed: () => closes };
}

function send(bridge: NativeBridge, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  bridge.receive(Buffer.concat([header, body]));
}

describe("NativeBridge", () => {
  it("records the link on hello even though collection has not been consented to", () => {
    const h = harness(facts({ consentedPolicyVersion: null }));

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "hello", extensionVersion: "0.1.0" });

    // The link is a statement about what this machine CAN see — which is what lets the
    // consent screen promise website tracking honestly — and recording it is not
    // collecting.
    expect(h.observed).toEqual([
      {
        url: null,
        at: "2026-08-05T09:00:00.000Z",
        extensionVersion: "0.1.0",
        linked: true,
        browser: null,
      },
    ]);
  });

  it("passes on the browser that named itself, so two of them can be told apart", () => {
    const h = harness();

    send(h.bridge, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: "hello",
      extensionVersion: "0.1.0",
      browser: "Edge",
    });

    expect(h.observed[0]).toMatchObject({ browser: "Edge", linked: true });
  });

  it("reports a page only while the consent gate is open", () => {
    const open = harness();
    send(open.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/x", at: "t" });
    expect(open.observed).toEqual([{ url: "https://a.test/x", at: "2026-08-05T09:00:00.000Z" }]);

    for (const shut of [
      facts({ revoked: true }),
      facts({ deviceId: null }),
      facts({ consentedPolicyVersion: "old" }),
    ]) {
      const h = harness(shut);
      send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/x", at: "t" });
      expect(h.observed).toEqual([]);
    }
  });

  it("stamps the observation with the host's clock, never the browser's", () => {
    const h = harness();

    send(h.bridge, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: "page",
      url: "https://a.test/",
      at: "1999-01-01T00:00:00.000Z",
    });

    expect(h.observed[0]?.at).toBe("2026-08-05T09:00:00.000Z");
  });

  it("clears the page when the browser reports nothing in view", () => {
    const h = harness();

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "cleared", at: "t" });

    expect(h.observed).toEqual([{ url: null, at: "2026-08-05T09:00:00.000Z" }]);
  });

  it("logs a refused navigation rather than inventing an activity event for it", () => {
    const h = harness();

    send(h.bridge, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: "blocked",
      url: "https://blocked.test/",
      ruleId: 7,
      at: "t",
    });

    expect(h.observed).toEqual([]);
    expect(h.logs.join("\n")).toContain("https://blocked.test/ (rule 7)");
  });

  it("answers every message with the current state, so a withdrawal lands on the next navigation", () => {
    const h = harness();

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "cleared", at: "t" });

    expect(h.sent).toEqual([stateMessageOf(facts())]);
  });

  it("answers an unrecognised frame with a protocol error instead of dropping it silently", () => {
    const h = harness();

    send(h.bridge, { v: 99, type: "page", url: "https://a.test/", at: "t" });

    expect(h.observed).toEqual([]);
    expect((h.sent[0] as { type: string }).type).toBe("error");
  });

  it("rejects a page report with no url and one that is absurdly long", () => {
    const h = harness();

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "", at: "t" });
    send(h.bridge, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: "page",
      url: `https://a.test/${"x".repeat(2100)}`,
      at: "t",
    });

    expect(h.observed).toEqual([]);
    expect(h.sent.every((message) => (message as { type: string }).type === "error")).toBe(true);
  });

  it("abandons the channel on a frame it cannot resynchronise from", () => {
    const h = harness();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_BRIDGE_MESSAGE_BYTES + 1, 0);

    expect(h.bridge.receive(header)).toBe(false);
    expect(h.closed()).toBe(1);
  });

  it("closes the channel when the pipe refuses a write", () => {
    const h = harness();
    vi.spyOn(h.ports, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });

    h.bridge.send({ v: BRIDGE_PROTOCOL_VERSION, type: "error", message: "x" });

    expect(h.closed()).toBe(1);
  });
});

/**
 * The browser half of the `websites` setting.
 *
 * The extension is a separate process reading the same JSON, so missing this would
 * leave the browser reporting addresses long after the collection loop had stopped —
 * the "revocation is immediate" failure mode, one process further out.
 *
 * The refusal lands on the host rather than on `MonitoringState` because that enum is
 * byte-identical with the extension's copy and has no member for "collecting, but not
 * websites". Borrowing `consent-required` for it would tell the employee to go and
 * accept a policy they have already accepted, and would switch off the restriction
 * rules too — which are enforcement, not observation.
 */
describe("mayRecordWebsites", () => {
  it("permits when the device has no scope of its own", () => {
    expect(mayRecordWebsites(facts())).toBe(true);
  });

  it("permits when the scope names websites and refuses when it does not", () => {
    expect(mayRecordWebsites(facts({ collection: ["applications", "websites"] }))).toBe(true);
    expect(mayRecordWebsites(facts({ collection: ["applications"] }))).toBe(false);
  });

  it("refuses whenever the consent gate itself is shut, whatever the scope says", () => {
    for (const shut of [
      facts({ collection: ["websites"], revoked: true }),
      facts({ collection: ["websites"], deviceId: null }),
      facts({ collection: ["websites"], consentedPolicyVersion: "old" }),
    ]) {
      expect(mayRecordWebsites(shut)).toBe(false);
    }
  });
});

describe("NativeBridge with websites switched off", () => {
  const OFF = facts({ collection: ["applications", "screenshots"] });

  it("records nothing from a page report, and clears what the last one left behind", () => {
    // Reported as "nothing in view" rather than skipped: the address the last permitted
    // navigation wrote is still in the link file, and the tracker would go on being
    // offered it until the browser happened to restart.
    const h = harness(OFF);

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/x", at: "t" });

    expect(h.observed).toEqual([{ url: null, at: "2026-08-05T09:00:00.000Z" }]);
  });

  it("still tells the extension it is collecting, so the rules stay enforced", () => {
    const h = harness(OFF);

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/x", at: "t" });

    expect((h.sent[0] as { monitoring: string }).monitoring).toBe("collecting");
  });

  it("still records the link on hello, which is a capability rather than an observation", () => {
    const h = harness(OFF);

    send(h.bridge, { v: BRIDGE_PROTOCOL_VERSION, type: "hello", extensionVersion: "0.1.0" });

    expect(h.observed[0]?.linked).toBe(true);
  });
});
