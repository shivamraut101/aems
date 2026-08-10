/**
 * The native messaging host, as a *Node* entry point.
 *
 * # Why this file exists at all, rather than a branch in `index.ts`
 *
 * On Windows the Electron binary writes a bare CRLF to stdout during Chromium's
 * startup, before a single line of application JavaScript runs. Measured here, with
 * this repository's own Electron 43.3.0: a host that writes nothing at all still
 * produces two bytes on its stdout. For a Chrome native messaging host that is fatal —
 * the wire is a little-endian uint32 length followed by exactly that many bytes, so two
 * stray leading bytes make Chrome read `0D 0A xx xx` as the first length prefix, and the
 * port is desynchronised from its first byte with nothing in any log to say why.
 *
 * Running the same binary with `ELECTRON_RUN_AS_NODE=1` produces a clean stream — no
 * Chromium, no console attach, no stray bytes, and a startup measured in tens of
 * milliseconds rather than a second. That is what the launcher `native-host.ts` writes
 * does, and this is the script it runs.
 *
 * The cost of that mode is that `require("electron")` no longer returns the Electron
 * module — it returns the path to the executable as a *string*. So this entry may not
 * import anything that touches Electron, directly or transitively, which is exactly why
 * it is a separate entry point instead of a branch inside `index.ts`: that bundle links
 * `import { app, safeStorage, ... } from "electron"` at its top, and under Node that is
 * a link error before any branch is reached.
 *
 * Everything imported below is pure Node by construction.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { readBridgeInvocation, readUserDataPath, USER_DATA_FLAG } from "./bridge.js";
import { BROWSER_LINK_FILE, BrowserLinkStore } from "./bridge-link.js";
import { startBridge } from "./bridge-runtime.js";
import { AGENT_CONFIG_FILE, agentStateDirectory, JsonFile, nodeDurableFs } from "./persistence.js";

/** stderr, never stdout: stdout is the wire. */
function log(message: string, error?: unknown): void {
  process.stderr.write(`[aems-bridge] ${message} ${error === undefined ? "" : String(error)}\n`);
}

export function main(argv: readonly string[]): void {
  const invocation = readBridgeInvocation(argv);

  if (invocation === null) {
    // Reached only if the launcher was edited by hand. Refusing loudly is what makes
    // the extension report "not connected" instead of hanging on an open pipe.
    log("Started without a browser origin; refusing to serve a channel");
    process.exit(1);
  }

  const userDataPath = readUserDataPath(argv);
  if (userDataPath === null) {
    log(`Started without ${USER_DATA_FLAG}; the agent's configuration cannot be located`);
    process.exit(1);
  }

  const fs = nodeDurableFs();

  startBridge(invocation, {
    stdin: process.stdin,
    stdout: process.stdout,
    readConfig: () => fs.read(join(userDataPath, AGENT_CONFIG_FILE)),
    link: new BrowserLinkStore(
      new JsonFile(fs, join(agentStateDirectory(userDataPath), BROWSER_LINK_FILE), { log }),
    ),
    log,
    now: () => new Date(),
    newEventId: () => randomUUID(),
    exit: (code) => {
      process.exit(code);
    },
  });

  // stdin starts paused, and it is also the only handle keeping this process alive —
  // without this the host would exit before Chrome sent a byte.
  process.stdin.resume();
}

main(process.argv);
