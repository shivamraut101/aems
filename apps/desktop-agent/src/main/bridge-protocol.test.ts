import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BRIDGE_PROTOCOL_VERSION,
  isExtensionMessage,
  isHostMessage,
  isWebsiteRule,
  NATIVE_HOST_NAME,
} from "./bridge-protocol.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const AGENT_COPY = join(HERE, "bridge-protocol.ts");
const EXTENSION_COPY = join(
  HERE,
  "..",
  "..",
  "..",
  "browser-extension",
  "src",
  "protocol.ts",
);

const MARKER = "// === SHARED PROTOCOL — byte-identical in both copies below this line ===";

function sharedHalf(path: string): string {
  const source = readFileSync(path, "utf8");
  const index = source.indexOf(MARKER);

  expect(index, `${path} has lost its shared-protocol marker`).toBeGreaterThan(-1);
  // Normalised for line endings only: git may check one copy out with CRLF and the
  // other with LF, and that is not drift.
  return source.slice(index + MARKER.length).replace(/\r\n/g, "\n");
}

describe("the shared protocol", () => {
  it("is byte-identical in the agent and in the extension", () => {
    // The two are compiled by different toolchains and neither can import the other's
    // build, so the only thing holding them together is this assertion. A field added
    // on one side and not the other is a channel that silently drops messages.
    expect(sharedHalf(EXTENSION_COPY)).toBe(sharedHalf(AGENT_COPY));
  });

  it("carries no import, because two toolchains compile it", () => {
    expect(sharedHalf(AGENT_COPY)).not.toMatch(/^\s*import\s/m);
  });

  it("uses a reverse-DNS host name, which is what Chrome requires", () => {
    expect(NATIVE_HOST_NAME).toBe("com.aems.agent.bridge");
    expect(NATIVE_HOST_NAME).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
  });
});

describe("isExtensionMessage", () => {
  const at = "2026-08-05T09:00:00.000Z";

  it("accepts the four frames the extension may send", () => {
    expect(isExtensionMessage({ v: 1, type: "hello", extensionVersion: "0.1.0" })).toBe(true);
    expect(isExtensionMessage({ v: 1, type: "page", url: "https://a.test/", at })).toBe(true);
    expect(isExtensionMessage({ v: 1, type: "cleared", at })).toBe(true);
    expect(isExtensionMessage({ v: 1, type: "blocked", url: "a.test", ruleId: 2, at })).toBe(true);
  });

  it("refuses a version it does not speak rather than coercing it", () => {
    expect(isExtensionMessage({ v: 2, type: "cleared", at })).toBe(false);
    expect(isExtensionMessage({ type: "cleared", at })).toBe(false);
  });

  it("refuses anything that is not one of the four", () => {
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage("page")).toBe(false);
    expect(isExtensionMessage({ v: 1, type: "state" })).toBe(false);
  });

  it("takes a browser name on hello, or none at all", () => {
    expect(isExtensionMessage({ v: 1, type: "hello", extensionVersion: "0.1.0", browser: "Edge" })).toBe(
      true,
    );
    // An extension built before the field still opens a channel; it is one entry in the
    // link file rather than two, which understates a count rather than losing a browser.
    expect(isExtensionMessage({ v: 1, type: "hello", extensionVersion: "0.1.0" })).toBe(true);
    expect(
      isExtensionMessage({ v: 1, type: "hello", extensionVersion: "0.1.0", browser: "x".repeat(41) }),
    ).toBe(false);
  });

  it("bounds the stamp, so a megabyte string cannot arrive as a timestamp", () => {
    expect(isExtensionMessage({ v: 1, type: "cleared", at: "x".repeat(41) })).toBe(false);
    expect(isExtensionMessage({ v: 1, type: "cleared", at: "" })).toBe(false);
  });

  it("bounds the address at what an address bar actually holds", () => {
    expect(
      isExtensionMessage({ v: 1, type: "page", url: `https://a.test/${"x".repeat(2040)}`, at }),
    ).toBe(false);
  });
});

describe("isHostMessage", () => {
  it("accepts the state frame with a validated rule list", () => {
    expect(
      isHostMessage({
        v: BRIDGE_PROTOCOL_VERSION,
        type: "state",
        monitoring: "collecting",
        policy: null,
        rules: [{ id: 1, domain: "a.test", reason: null }],
        contact: null,
      }),
    ).toBe(true);
  });

  it("refuses a monitoring state it does not know, which would fail open in the browser", () => {
    expect(
      isHostMessage({ v: 1, type: "state", monitoring: "maybe", rules: [], contact: null }),
    ).toBe(false);
  });

  it("refuses a state frame whose rules are not all rules", () => {
    expect(isHostMessage({ v: 1, type: "state", monitoring: "collecting", rules: [{}] })).toBe(
      false,
    );
    expect(isHostMessage({ v: 1, type: "state", monitoring: "collecting", rules: "none" })).toBe(
      false,
    );
  });

  it("accepts the error frame", () => {
    expect(isHostMessage({ v: 1, type: "error", message: "mismatch" })).toBe(true);
    expect(isHostMessage({ v: 1, type: "error" })).toBe(false);
  });
});

describe("isWebsiteRule", () => {
  it("requires a positive integer id, because a browser rule id must be one", () => {
    expect(isWebsiteRule({ id: 1, domain: "a.test", reason: null })).toBe(true);
    expect(isWebsiteRule({ id: 0, domain: "a.test", reason: null })).toBe(false);
    expect(isWebsiteRule({ id: 1.5, domain: "a.test", reason: null })).toBe(false);
  });

  it("bounds the domain at the DNS limit", () => {
    expect(isWebsiteRule({ id: 1, domain: "", reason: null })).toBe(false);
    expect(isWebsiteRule({ id: 1, domain: "a".repeat(254), reason: null })).toBe(false);
  });

  it("allows a reason or its absence, and nothing else", () => {
    expect(isWebsiteRule({ id: 1, domain: "a.test", reason: "Not work related" })).toBe(true);
    expect(isWebsiteRule({ id: 1, domain: "a.test", reason: 7 })).toBe(false);
  });
});
