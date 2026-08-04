import type { AgentApi } from "../../shared/types/index.js";

/**
 * The preload bridge, or null when it is not there.
 *
 * `window.aems` is declared non-optional because a healthy build always runs the
 * preload script — but if it ever fails to attach, an unguarded read leaves the
 * employee staring at a blank window with no idea whether they are being monitored.
 * A compliance tool has to be able to say "I don't know" out loud.
 */
export function agentBridge(): AgentApi | null {
  const bridge = window.aems as AgentApi | undefined;
  return bridge ?? null;
}

/**
 * Turns a rejected `invoke` into something an employee can act on.
 *
 * Electron rethrows a failed handler as `Error invoking remote method
 * 'aems:enroll': Error: <message>`. Showing that verbatim puts an IPC channel name
 * in front of someone who is trying to sign in to their laptop.
 */
export function bridgeErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  const unwrapped = raw.replace(/^.*Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
  const message = unwrapped.trim();
  return message.length > 0 ? message : fallback;
}
