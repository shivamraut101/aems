import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

import { ConsentGate } from "./ConsentGate";

interface AgentStatus {
  enrolled: boolean;
  collecting: boolean;
  policyVersion: string | null;
  consentRequired: boolean;
}

/**
 * Agent window.
 *
 * Deliberately plain: per docs/design.md the desktop agent is a status readout, not
 * a dashboard. The employee should be able to tell at a glance what is being
 * collected and that it is running — nothing here is hidden or minimised away.
 */
export function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<AgentStatus>("get_status"));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!status) {
    return (
      <main className="shell">
        <p className="muted">Starting…</p>
      </main>
    );
  }

  if (!status.enrolled || status.consentRequired) {
    return <ConsentGate status={status} onDone={refresh} />;
  }

  return (
    <main className="shell">
      <h1>Company Monitor</h1>

      <dl className="rows">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={status.collecting ? "dot dot-on" : "dot dot-off"} />
            {status.collecting ? "Connected" : "Paused"}
          </dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>{status.policyVersion ?? "—"}</dd>
        </div>
      </dl>

      <p className="muted">
        Your employer records application usage, websites, idle time and periodic
        screenshots on this company device. You can withdraw consent at any time from
        the web dashboard.
      </p>

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
