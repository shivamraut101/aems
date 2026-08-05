/**
 * The extension manifest, written as code so every permission carries its reason.
 *
 * `manifest.json` has no comment syntax that Chrome is documented to accept, and an
 * over-permissioned extension is what gets an enterprise rollout refused — so the
 * justification cannot live in a file nobody reads. `tools/build.mjs` serialises this
 * into `dist/manifest.json`, and `manifest.test.ts` in the desktop agent asserts the
 * permission set against this object, so a permission cannot be added without a
 * reviewer seeing it.
 *
 * The rule this list is written to: **every entry must be load-bearing for either
 * reporting a domain or refusing a navigation.** Anything else is out of scope — this
 * is scope §2.5 plus the one control the client asked for by name, not an MDM.
 */

import { AEMS_EXTENSION_IDS } from "./protocol.js";

/** The blocked page, which a `declarativeNetRequest` redirect navigates a tab to. */
export const BLOCKED_PAGE = "blocked.html";

/**
 * The committed RSA public key that pins the extension id.
 *
 * Chrome derives an unpacked extension's id from its install path unless the manifest
 * carries a key, so without this the id would differ on every machine and no native
 * messaging host manifest could name it in `allowed_origins`. The matching private key
 * is NOT in the repository — it is only needed to pack a CRX, and `keys/` is ignored.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyo1KgYhU3YO8pcMNeGbTUoGdB5Gxjp5R1ZXIs5NIPc7ycV4aEyXQ2lp0PXviLAqhJZmVMsLCYgyi1OnNXx2I/Ar6+EtGWr3V7XkAPJyr6M1JloNopbvGI/v+3X6kVqljnmAf3oXgDYgYIr3szZfs+pMLLJB9cB2fDX3NbSVFLaPcHql7vlFMRAViqZ9lu0Mmk38EpIYK1S0FjTnvgE7TLcZL/N2qUZXPCHqcGkVh8f8usBAtsK4pL3b+kEuZXEL1mu3idvjbjzS1aU6fXFMl7PndoyyJt73ZZEIGIiUUCpgRjMCNkZ/Uhbrtfvu8S+la+udDS4tcpJTCZDMREAbk7QIDAQAB";

export const manifest = {
  manifest_version: 3,

  // Named as a companion, not as a watcher. `docs/design.md` rules out surveillance
  // framing in UI text, and the name in the employee's extension list is UI text.
  name: "AEMS Workforce Companion",
  version: "0.1.0",
  description:
    "Reports the sites visited on this company device to the AEMS agent, and applies the website rules in the monitoring policy.",

  key: EXTENSION_PUBLIC_KEY,

  // `requestDomains` in a dynamic rule needs 101; `type: "module"` service workers need
  // 111. Declaring the floor means an old browser refuses to install the extension
  // rather than installing one whose blocking silently never applies.
  minimum_chrome_version: "111",

  background: {
    service_worker: "background.js",
    type: "module",
  },

  action: {
    default_popup: "popup.html",
    default_title: "AEMS Workforce Companion",
  },

  /**
   * PERMISSIONS — each one, and why it cannot be dropped.
   *
   * - `nativeMessaging`: the entire transport. The extension talks only to the AEMS
   *   agent on this machine, through a host manifest that names this extension id; it
   *   makes no network requests of its own and has no remote endpoint to talk to.
   *
   * - `tabs`: reading `tab.url` for the focused tab. This is the one thing the
   *   extension exists to do — on Windows there is no supported way to read a browser's
   *   address bar from outside the browser, which is why website tracking needs an
   *   extension at all. Note what this is NOT: no content script is declared anywhere
   *   in this manifest, so nothing is ever injected into a page and no page content,
   *   form field or keystroke is readable by this extension.
   *
   * - `declarativeNetRequest`: the website restriction the client asked for. Chosen
   *   over `webRequestBlocking` deliberately — a declarative rule lets Chrome do the
   *   matching without the extension ever seeing the request, so enforcement cannot
   *   become a second, invisible collection channel.
   */
  permissions: ["nativeMessaging", "tabs", "declarativeNetRequest"],

  /**
   * HOST PERMISSIONS.
   *
   * Required for one thing only: a `declarativeNetRequest` rule may redirect a request
   * to the blocked page only where the extension has host access to that request.
   * Restrictions are configured by an administrator against arbitrary domains, so the
   * set cannot be narrowed ahead of time without silently failing to block whatever was
   * left out.
   *
   * Scoped to http and https rather than `<all_urls>`, which would additionally cover
   * `file://` and `ftp://`. Neither is a website anybody is restricted from, so
   * granting them would be permission for its own sake.
   */
  host_permissions: ["http://*/*", "https://*/*"],

  /**
   * The blocked page has to be reachable as a redirect target from an ordinary web
   * navigation, which is what makes it a web-accessible resource. Nothing else in the
   * extension is exposed — the popup and the service worker are not listed.
   */
  web_accessible_resources: [
    {
      resources: [BLOCKED_PAGE],
      matches: ["http://*/*", "https://*/*"],
    },
  ],
} as const;

/** The ids the agent's host manifest admits. Exported so a test can hold the two together. */
export const PINNED_EXTENSION_IDS = AEMS_EXTENSION_IDS;
