import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

interface Props {
  status: { enrolled: boolean; consentRequired: boolean; policyVersion: string | null };
  onDone: () => void;
}

/**
 * Blocking consent screen.
 *
 * Nothing is collected until this is accepted — the Rust loop checks
 * `may_collect()` on every tick, and the API rejects ingestion without a consent
 * record. This screen is the employee-facing half of that rule; it is not
 * dismissible, and it states plainly what will be recorded before asking.
 */
export function ConsentGate({ status, onDone }: Props) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await invoke("enroll", { accessToken: token.trim() });
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await invoke("accept_consent");
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status.enrolled) {
    return (
      <main className="shell">
        <h1>Sign in</h1>
        <p className="muted">
          Sign in with your work account to link this device to your employer&rsquo;s
          workspace.
        </p>

        <label className="field">
          <span>Access token</span>
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste your session token"
            autoComplete="off"
          />
        </label>

        <button type="button" onClick={() => void signIn()} disabled={busy || !token.trim()}>
          {busy ? "Linking…" : "Link this device"}
        </button>

        {error ? <p className="error">{error}</p> : null}
      </main>
    );
  }

  return (
    <main className="shell">
      <h1>Before monitoring starts</h1>

      <p>
        This is a company-owned device. Once you accept, the AEMS agent will record:
      </p>

      <ul className="list">
        <li>Which applications you have open, and for how long</li>
        <li>Website domains visited in your browser</li>
        <li>Periods with no keyboard or mouse input</li>
        <li>Periodic screenshots of your primary display</li>
        <li>Device name, operating system and installed applications</li>
      </ul>

      <p className="muted">
        A tray icon stays visible whenever monitoring is running. You can withdraw
        consent at any time from the web dashboard, which stops collection
        immediately. Policy version {status.policyVersion ?? "—"}.
      </p>

      <button type="button" onClick={() => void accept()} disabled={busy}>
        {busy ? "Saving…" : "I understand and agree"}
      </button>

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
