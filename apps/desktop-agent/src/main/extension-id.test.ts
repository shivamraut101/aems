/**
 * The two constants that have to agree across the two packages, held together by a
 * derivation rather than by a comment.
 *
 * The agent's native messaging host manifest admits exactly the extension ids in
 * `AEMS_EXTENSION_IDS`; Chrome derives an extension's id from the public key in its
 * manifest. If those two are ever edited apart the channel simply never opens, and the
 * only symptom is an extension that reports "not connected" on every machine.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EXTENSION_PUBLIC_KEY, manifest } from "../../../browser-extension/src/manifest.js";
import { AEMS_EXTENSION_IDS } from "./bridge-protocol.js";

/**
 * Chrome's own derivation: SHA-256 of the DER public key, the first 16 bytes as hex,
 * each hex digit mapped onto `a`-`p`.
 */
function extensionIdFrom(publicKeyBase64: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex")
    .slice(0, 32);

  return [...digest].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

describe("the pinned extension id", () => {
  it("is the id Chrome will derive from the committed public key", () => {
    expect(extensionIdFrom(EXTENSION_PUBLIC_KEY)).toBe(AEMS_EXTENSION_IDS[0]);
  });

  it("is the 32-character a-p id Chrome actually produces", () => {
    expect(AEMS_EXTENSION_IDS).toHaveLength(1);
    expect(AEMS_EXTENSION_IDS[0]).toMatch(/^[a-p]{32}$/);
  });

  it("carries the key in the manifest, without which the id changes per machine", () => {
    expect(manifest.key).toBe(EXTENSION_PUBLIC_KEY);
  });
});

describe("the extension manifest", () => {
  it("asks for exactly three permissions, each one load-bearing", () => {
    // Adding one has to fail here first. An over-permissioned monitoring extension is
    // what gets an enterprise rollout refused, and the justification for each of these
    // is in `src/manifest.ts` next to the entry.
    expect([...manifest.permissions]).toEqual([
      "nativeMessaging",
      "tabs",
      "declarativeNetRequest",
    ]);
  });

  it("takes host access only for http and https, not for files or every scheme", () => {
    expect([...manifest.host_permissions]).toEqual(["http://*/*", "https://*/*"]);
  });

  it("declares no content script, so nothing is ever injected into a page", () => {
    expect(manifest).not.toHaveProperty("content_scripts");
  });

  it("exposes only the blocked page to the web", () => {
    expect(manifest.web_accessible_resources.flatMap((entry) => [...entry.resources])).toEqual([
      "blocked.html",
    ]);
  });

  it("runs its worker as a module, which is what lets the build skip a bundler", () => {
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
  });
});
