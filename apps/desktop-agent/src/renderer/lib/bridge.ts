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

  // Electron wraps anything thrown in a handler as
  //   Error invoking remote method 'aems:enroll': AemsApiError: <message>
  // The class name survives that unwrapping, and `AemsApiError:` in front of a
  // sentence is noise to the person reading it — it names our code, not their problem.
  const unwrapped = raw
    .replace(/^.*Error invoking remote method '[^']*':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "");

  const message = unwrapped.trim();
  if (message.length === 0) return fallback;

  // A message that still looks like a serialised object never reached a human
  // readably. Better the fallback, which at least says what to do next.
  if (message.startsWith("[") || message.startsWith("{")) return fallback;

  return message;
}
