import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { BrowserLinkStore } from "./bridge-link.js";
import { BRIDGE_PROTOCOL_VERSION } from "./bridge-protocol.js";
import type { BridgeRuntimeDeps } from "./bridge-runtime.js";
import { readBridgeConfigFacts, startBridge } from "./bridge-runtime.js";
import { FrameDecoder } from "./bridge.js";
import { JsonFile } from "./persistence.js";

const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION}/`;

const ENROLLED = JSON.stringify({
  apiUrl: "http://localhost:3001",
  deviceId: "device-1",
  profileId: "profile-1",
  companyId: "company-1",
  consentedPolicyVersion: "2026.08.01",
  policy: { version: "2026.08.01", name: "Standard", screenshotIntervalSeconds: 600 },
  revoked: false,
});

describe("readBridgeConfigFacts", () => {
  it("reads the four facts out of the agent's plaintext config", () => {
    expect(readBridgeConfigFacts(ENROLLED)).toEqual({
      deviceId: "device-1",
      consentedPolicyVersion: "2026.08.01",
      policy: { version: "2026.08.01", name: "Standard", screenshotIntervalSeconds: 600 },
      collection: null,
      revoked: false,
    });
  });

  it("keeps the whole policy object, so a restriction field the schema gains later survives", () => {
    const withRestrictions = JSON.stringify({
      deviceId: "d",
      consentedPolicyVersion: "1",
      policy: {
        version: "1",
        name: "P",
        websiteRestrictions: { rules: [{ id: 1, domain: "a.test", reason: null }], contact: "IT" },
      },
    });

    const facts = readBridgeConfigFacts(withRestrictions);

    expect((facts.policy as unknown as { websiteRestrictions: unknown }).websiteRestrictions).toEqual({
      rules: [{ id: 1, domain: "a.test", reason: null }],
      contact: "IT",
    });
  });

  it("lands on not-enrolled for a missing, unparseable or wrong-shaped file", () => {
    const empty = {
      deviceId: null,
      consentedPolicyVersion: null,
      policy: null,
      collection: null,
      revoked: false,
    };

    expect(readBridgeConfigFacts(null)).toEqual(empty);
    expect(readBridgeConfigFacts("{half written")).toEqual(empty);
    expect(readBridgeConfigFacts("[]")).toEqual({ ...empty });
    expect(readBridgeConfigFacts("null")).toEqual(empty);
  });

  it("refuses a policy without the two fields the blocked page has to quote", () => {
    expect(readBridgeConfigFacts(JSON.stringify({ policy: { version: 1, name: "x" } })).policy).toBeNull();
    expect(readBridgeConfigFacts(JSON.stringify({ policy: { version: "1" } })).policy).toBeNull();
  });

  it("reads the device's collection scope, so the browser half sees the same set", () => {
    const scoped = JSON.stringify({ deviceId: "d", collection: ["applications", "websites"] });

    expect(readBridgeConfigFacts(scoped).collection).toEqual(["applications", "websites"]);
  });

  it("reads an absent or malformed scope as null, which permits — same as an absent row", () => {
    expect(readBridgeConfigFacts(JSON.stringify({ deviceId: "d" })).collection).toBeNull();
    expect(readBridgeConfigFacts(JSON.stringify({ collection: "websites" })).collection).toBeNull();
    expect(readBridgeConfigFacts(JSON.stringify({ collection: [1, "websites"] })).collection).toEqual(
      ["websites"],
    );
  });

  it("reads revocation as true only when it is explicitly true", () => {
    expect(readBridgeConfigFacts(JSON.stringify({ revoked: true })).revoked).toBe(true);
    expect(readBridgeConfigFacts(JSON.stringify({ revoked: "yes" })).revoked).toBe(false);
  });
});

interface Harness {
  deps: BridgeRuntimeDeps;
  frames: unknown[];
  logs: string[];
  exits: number[];
  link: BrowserLinkStore;
  stdin: EventEmitter;
}

function harness(config: string | null = ENROLLED): Harness {
  const frames: unknown[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const decoder = new FrameDecoder();
  const stdin = new EventEmitter();

  let stored: string | null = null;
  const link = new BrowserLinkStore(
    new JsonFile(
      {
        read: () => stored,
        write: (_path, contents) => {
          stored = contents;
        },
        append: () => {},
        rename: () => {},
        remove: () => {
          stored = null;
        },
      },
      "link.json",
    ),
  );

  const deps: BridgeRuntimeDeps = {
    stdin: stdin as unknown as NodeJS.ReadableStream,
    stdout: {
      write: (chunk) => {
        for (const message of decoder.push(chunk)) frames.push(message);
      },
    },
    readConfig: () => config,
    link,
    log: (message) => logs.push(message),
    now: () => new Date("2026-08-05T09:00:00.000Z"),
    exit: (code) => exits.push(code),
    allowedExtensionIds: [EXTENSION],
  };

  return { deps, frames, logs, exits, link, stdin };
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

describe("startBridge", () => {
  it("sends the state before the extension asks, so a live channel proves itself", () => {
    const h = harness();

    startBridge({ origin: ORIGIN, extensionId: EXTENSION }, h.deps);

    expect(h.frames).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: "state",
        monitoring: "collecting",
        policy: { version: "2026.08.01", name: "Standard" },
        rules: [],
        contact: null,
      },
    ]);
  });

  it("refuses an extension the manifest does not name, and writes nothing", () => {
    const h = harness();

    const bridge = startBridge(
      { origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/", extensionId: "ponmlkjihgfedcbaponmlkjihgfedcba" },
      h.deps,
    );

    expect(bridge).toBeNull();
    expect(h.frames).toEqual([]);
    expect(h.exits).toEqual([1]);
  });

  it("records the page report against the origin that sent it", () => {
    const h = harness();

    startBridge({ origin: ORIGIN, extensionId: EXTENSION }, h.deps);
    h.stdin.emit("data", frame({ v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/x", at: "t" }));

    expect(h.link.read().browsers[ORIGIN]).toMatchObject({
      url: "https://a.test/x",
      observedAt: "2026-08-05T09:00:00.000Z",
    });
  });

  it("clears the previous page on hello, so a reopened browser does not resume a stale site", () => {
    const h = harness();

    startBridge({ origin: ORIGIN, extensionId: EXTENSION }, h.deps);
    h.stdin.emit("data", frame({ v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/", at: "t" }));
    h.stdin.emit("data", frame({ v: BRIDGE_PROTOCOL_VERSION, type: "hello", extensionVersion: "0.1.0" }));

    expect(h.link.read().browsers[ORIGIN]).toMatchObject({
      url: null,
      extensionVersion: "0.1.0",
      linkedAt: "2026-08-05T09:00:00.000Z",
    });
  });

  it("records nothing at all in self-test mode", () => {
    const h = harness();

    startBridge({ origin: null, extensionId: null }, h.deps);
    h.stdin.emit("data", frame({ v: BRIDGE_PROTOCOL_VERSION, type: "hello", extensionVersion: "0.1.0" }));
    h.stdin.emit("data", frame({ v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/", at: "t" }));

    // A local process that can spawn the binary must not be able to write a domain into
    // somebody's activity record just by passing a flag.
    expect(h.link.read().browsers).toEqual({});
    expect(h.frames).toHaveLength(3);
    expect(h.logs.join("\n")).toContain("nothing will be recorded");
  });

  it("re-reads the config per message, so a withdrawal lands on the next navigation", () => {
    const h = harness();
    let config = ENROLLED;
    h.deps.readConfig = () => config;

    startBridge({ origin: ORIGIN, extensionId: EXTENSION }, h.deps);

    config = JSON.stringify({ deviceId: "device-1", revoked: true });
    h.stdin.emit("data", frame({ v: BRIDGE_PROTOCOL_VERSION, type: "page", url: "https://a.test/", at: "t" }));

    expect(h.link.read().browsers).toEqual({});
    expect((h.frames.at(-1) as { monitoring: string }).monitoring).toBe("revoked");
  });

  it("exits cleanly when the browser closes the pipe", () => {
    const h = harness();

    startBridge({ origin: ORIGIN, extensionId: EXTENSION }, h.deps);
    h.stdin.emit("end");

    expect(h.exits).toEqual([0]);
  });

  it("serves a machine that has never enrolled without pretending otherwise", () => {
    const h = harness(null);

    startBridge({ origin: ORIGIN, extensionId: EXTENSION }, h.deps);

    expect((h.frames[0] as { monitoring: string }).monitoring).toBe("not-enrolled");
  });
});
