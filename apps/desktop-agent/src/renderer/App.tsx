import type { ReactElement } from "react";

import { Notice } from "./components/Notice.js";
import { Shell } from "./components/Shell.js";
import { useAgentStatus } from "./hooks/useAgentStatus.js";
import { screenFor } from "./lib/view.js";
import { ConsentScreen } from "./screens/ConsentScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { StatusScreen } from "./screens/StatusScreen.js";

/**
 * Which screen is on show is a function of agent state, never of navigation.
 *
 * There is no router and no back button on purpose: the consent gate must not be
 * something an employee can step around, and the readout must not be reachable
 * before consent exists.
 */
export function App(): ReactElement {
  const { state, adopt } = useAgentStatus();

  if (state.phase === "loading") {
    return (
      <Shell>
        <p className="prose">Checking with the agent…</p>
      </Shell>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <Shell heading="Agent unavailable">
        <Notice tone="warn" title="This window cannot reach the agent">
          {state.message}
        </Notice>
      </Shell>
    );
  }

  const screen = screenFor(state.status);
  if (screen === "login") return <LoginScreen onEnrolled={adopt} />;
  if (screen === "consent") return <ConsentScreen status={state.status} onAccepted={adopt} />;
  return <StatusScreen status={state.status} />;
}
