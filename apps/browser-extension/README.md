# AEMS Workforce Companion — managed browser extension

MV3, Chrome and Edge. Two jobs and no others:

1. Tell the AEMS desktop agent which site is in the focused tab.
2. Apply the website rules in the monitoring policy the agent hands back.

It exists because **on Windows there is no supported way to read a browser's address
bar from outside the browser.** The desktop agent's Windows URL reader recovers a host
only from the rare page that carries no `<title>` of its own, so scope §2.5 ("browser
domain, time spent") was honest but near-empty. An extension inside the browser knows
the address for certain — and the mechanism that reports a URL is the mechanism that
can refuse one, which is why website *restriction* and website *tracking* are one piece
of work rather than two.

---

## Transport: native messaging, not a local HTTP listener

Decided at design review; do not re-litigate.

`chrome.runtime.connectNative` starts the agent's own binary as a native messaging
host, and the two exchange length-prefixed JSON over that child's stdio.

A `127.0.0.1` listener in the agent was rejected because **any** local process could
POST fabricated activity to it under the device token, and a hostile process that
grabbed the port first would harvest every URL the employee visits. Native messaging
inverts both: Chrome starts the host, the host manifest pins which extension ids may
reach it, and nothing is listening when no browser is running.

The wire contract lives in `src/protocol.ts`. It is **byte-identical** to
`apps/desktop-agent/src/main/bridge-protocol.ts` below the marker line, and
`bridge-protocol.test.ts` in the desktop agent fails if the two ever drift.

### Two traps, both real, both handled

**1. The single-instance lock.** `apps/desktop-agent/src/main/index.ts` calls
`app.requestSingleInstanceLock()` at module scope. Chrome starts a *new* process per
port, so a bridge that reached that call would find the lock held, take the `else`
branch and quit before writing a byte — and asking for the lock at all fires
`second-instance` in the running agent, whose handler opens the agent window. The
bridge is therefore decided from `process.argv` **before** the lock is requested, and
the bridge branch never requests it.

**2. Electron's stdout is not byte-clean on Windows.** Measured against this
repository's Electron 43.3.0: a host that writes *nothing at all* still produces two
bytes — a bare CRLF — on its stdout, emitted during Chromium's startup before any
application code runs. Chrome reads the stream as a uint32 length followed by exactly
that many bytes, so those two bytes desynchronise the port from its first frame and it
dies with nothing in any log.

The fix is the launcher the agent registers: it runs the same executable with
`ELECTRON_RUN_AS_NODE=1` against a **separate build entry** (`out/main/bridge.js`),
which is plain Node — no Chromium, no console attach, no stray bytes. That entry may
not import anything that touches Electron, which is why it is a second entry rather
than a branch inside the agent's bundle.

---

## Permissions

Three, and each is load-bearing. The justification for each lives beside it in
`src/manifest.ts`, and `extension-id.test.ts` in the desktop agent fails if the list
changes.

| Permission | Why |
| --- | --- |
| `nativeMessaging` | The whole transport. There is no other endpoint. |
| `tabs` | Reading `tab.url` for the focused tab — the thing the extension exists to do. |
| `declarativeNetRequest` | Website restriction. Chrome does the matching; the extension never sees the request. |
| `host_permissions: http/https` | A DNR rule may redirect to the blocked page only where the extension has host access. Not `<all_urls>`: `file://` is not a website anybody is restricted from. |

**There is no content script anywhere in the manifest.** Nothing is injected into a
page, so no page content, form field or keystroke is readable by this extension. That
is the single most important sentence for an enterprise review, and it is enforced by a
test.

---

## Build and load

```sh
pnpm --filter @aems/browser-extension build      # -> dist/
pnpm --filter @aems/browser-extension typecheck
pnpm --filter @aems/browser-extension test
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

The extension id is pinned by the `key` in the manifest — a committed RSA public key
whose SHA-256 Chrome maps to `eofbpabfaedpbfaemggelkjhlcaagaii`. Without it, an
unpacked extension's id is derived from its install path and would differ on every
machine, so no host manifest could name it.

### Before a real rollout

- **Generate your own keypair.** The private half of the committed key is not in the
  repository (`keys/` is ignored), and packing a CRX needs it. Mint a new pair, put the
  base64 SPKI public key in `EXTENSION_PUBLIC_KEY`, and put the derived id in
  `AEMS_EXTENSION_IDS` in the agent's `bridge-protocol.ts`. The id derivation is
  SHA-256 of the DER public key, first 16 bytes as hex, each hex digit mapped onto
  `a`–`p`; `extension-id.test.ts` will tell you immediately if the two disagree.
- **Force-install it.** Chrome/Edge `ExtensionInstallForcelist`, per
  `docs/scope.md` §2.5's managed-fleet requirement.

---

## What the agent provides

**The API sends `policy.websiteRestrictions` on every heartbeat as of `3d05940`.** This
section previously said it did not, which was true for as long as the rules were stored
and served to nobody. Verified end to end on 2026-08-09: a heartbeat delivered

```json
"websiteRestrictions": {
  "rules": [{ "id": 1295131892, "domain": "facebook.com", "reason": "Not part of company work." }],
  "contact": "This site is not part of company work. Ask your manager if you need access."
}
```

to an enrolled Windows agent, which wrote it straight to `agent-config.json`.

**Only `block` + `domain` rules arrive.** The API refuses to reshape the other kinds: a
`url_pattern` squeezed into a domain field blocks the wrong pages, and an `allow` rule
handed to something that reads its list as "refuse these" inverts its own meaning. Those
come back as a count — `unenforceable` — rather than being silently dropped. Of three
enabled rules in the test company, one was delivered and two were counted.

**Nothing renders that count yet**, so an admin can still write a rule that is stored,
listed back to them, and enforced nowhere.

## The one thing left

The extension has never run in a browser. The agent's half is live — the native
messaging host is registered, the manifest pins the id, the policy arrives — but nothing
has connected to it, so `browser-link.json` has never been written. Closing that is
`ExtensionInstallForcelist` and a CRX signed with your own keypair, per *Before a real
rollout* above.
