import { useCallback, useEffect, useState } from "react";

import type { AgentStatus } from "../../shared/types/index.js";
import { agentBridge, bridgeErrorMessage } from "../lib/bridge.js";

export type AgentState =
  | { phase: "loading" }
  | { phase: "unavailable"; message: string }
  | { phase: "ready"; status: AgentStatus };

export interface AgentStatusHandle {
  state: AgentState;
  /** Adopts the status an action returned, so the screen changes without a round trip. */
  adopt: (status: AgentStatus) => void;
}

/**
 * The renderer's only source of truth.
 *
 * Seeds from one invoke, then follows the push channel. Nothing is derived or cached
 * locally: main decides whether collection is allowed, and a renderer that kept its
 * own copy would keep showing "Connected" through a revocation.
 */
export function useAgentStatus(): AgentStatusHandle {
  const [state, setState] = useState<AgentState>({ phase: "loading" });

  const adopt = useCallback((status: AgentStatus): void => {
    setState({ phase: "ready", status });
  }, []);

  useEffect(() => {
    const bridge = agentBridge();
    if (bridge === null) {
      setState({
        phase: "unavailable",
        message:
          "This window could not reach the agent. Nothing is being recorded until it can — quit from the tray icon and start the agent again.",
      });
      return;
    }

    let live = true;

    const unsubscribe = bridge.onStatusChanged((status) => {
      if (live) setState({ phase: "ready", status });
    });

    bridge
      .getStatus()
      .then((status) => {
        if (live) setState({ phase: "ready", status });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          phase: "unavailable",
          message: bridgeErrorMessage(error, "The agent did not report its status."),
        });
      });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return { state, adopt };
}
