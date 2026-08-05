import { useState, type FormEvent, type ReactElement } from "react";

import type { AgentStatus } from "../../shared/types/index.js";
import { Shell } from "../components/Shell.js";
import { agentBridge, bridgeErrorMessage } from "../lib/bridge.js";

interface LoginScreenProps {
  onEnrolled: (status: AgentStatus) => void;
}

const FORM_ID = "enrolment";

/**
 * Sign-in and device binding.
 *
 * The employee pastes the sign-in code the web dashboard issues rather than typing a
 * password here. The bridge only accepts an already-issued access token
 * (`EnrollRequest`), which keeps credentials out of the renderer entirely — this
 * window never holds anything reusable, and main drops the token once consent lands.
 */
/** Length of a code once the dashes and spaces are taken out. */
const CODE_LENGTH = 8;

/**
 * What is wrong with what was typed, or null if it is worth sending.
 *
 * Exported so the rules are testable without an Electron window. Deliberately does
 * NOT try to guess whether the code is real — only whether it is the right shape.
 * Telling someone their valid-looking code was rejected is the server's job; telling
 * them they have typed three characters is this screen's.
 */
export function codeComplaint(input: string): string | null {
  const bare = input.replace(/[\s-]/g, "");

  if (bare.length === 0) return "Enter the sign-in code from the dashboard.";

  if (/[^0-9A-Za-z]/.test(bare)) {
    return "A sign-in code is letters and numbers only, like APRN-6YS8.";
  }

  if (bare.length < CODE_LENGTH) {
    const missing = CODE_LENGTH - bare.length;
    return `That code is ${missing} character${missing === 1 ? "" : "s"} short. It looks like APRN-6YS8.`;
  }

  if (bare.length > CODE_LENGTH) {
    return "That is longer than a sign-in code. It looks like APRN-6YS8.";
  }

  return null;
}

export function LoginScreen({ onEnrolled }: LoginScreenProps): ReactElement {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = code.trim();

  async function enroll(): Promise<void> {
    const bridge = agentBridge();
    if (bridge === null || busy) return;

    // Answered here rather than by the server. A code too short to be one is a typo,
    // and a round trip to learn that is both slower and — until the message was
    // rewritten — how a person ended up reading a Zod issue array.
    const complaint = codeComplaint(trimmed);
    if (complaint !== null) {
      setError(complaint);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      onEnrolled(await bridge.enroll({ enrollmentCode: trimmed }));
    } catch (cause) {
      setError(
        bridgeErrorMessage(
          cause,
          "This device could not be signed in. Check the code and your connection, then try again.",
        ),
      );
      // Left set on success: the screen is being replaced, and re-enabling the button
      // first would offer a second enrolment of a machine that already has one.
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void enroll();
  }

  return (
    <Shell
      heading="Sign in to this device"
      footer={
        <button
          className="button button--primary button--block"
          type="submit"
          form={FORM_ID}
          disabled={busy || trimmed.length === 0}
        >
          {busy ? "Signing in…" : "Bind this device"}
        </button>
      }
    >
      <p className="prose">
        Signing in binds this computer to your employee account, so the work it reports is recorded
        under your name.
      </p>
      <p className="prose">
        Open the AEMS dashboard, go to <strong>Devices → Add device</strong>, and paste the sign-in
        code it shows you.
      </p>

      <form id={FORM_ID} onSubmit={submit} noValidate>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="field">
          <label className="field__label" htmlFor="sign-in-code">
            Sign-in code
          </label>
          <input
            id="sign-in-code"
            className="input"
            type="password"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-describedby="sign-in-code-hint"
          />
          <p className="field__hint" id="sign-in-code-hint">
            The code expires shortly after the dashboard shows it. Generate a new one if this fails.
          </p>
        </div>
      </form>

      <p className="meta">
        Nothing is recorded yet. The next screen sets out exactly what this agent collects, and you
        decide there.
      </p>
    </Shell>
  );
}
