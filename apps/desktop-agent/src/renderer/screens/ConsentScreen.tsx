import { describeDataTypes } from "@aems/types";
import { useEffect, useState, type ReactElement } from "react";

import type { AgentPolicy, AgentStatus, UrlFidelity } from "../../shared/types/index.js";
import { Shell } from "../components/Shell.js";
import { agentBridge, bridgeErrorMessage } from "../lib/bridge.js";
import { formatSpan } from "../lib/format.js";
import { consentTypes } from "../lib/view.js";

interface ConsentScreenProps {
  status: AgentStatus;
  onAccepted: (status: AgentStatus) => void;
}

/**
 * The consent gate.
 *
 * Blocking and non-dismissable by construction: it replaces the whole window, has no
 * close affordance, and the only way past it is to accept or to quit. Declining ends
 * the agent rather than parking it, because an agent that is running but not allowed
 * to do anything is exactly the ambiguity this screen exists to remove.
 *
 * Collection is already blocked in main and rejected again by the API — this screen
 * is where the employee is told what they are agreeing to, in the words the policy
 * actually means, before any of it happens.
 */
export function ConsentScreen({ status, onAccepted }: ConsentScreenProps): ReactElement {
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  /**
   * What this machine can see of a browser address.
   *
   * Seeded pessimistically: the list must never promise website addresses in the window
   * between mount and the permissions call returning, because a promise withdrawn a
   * moment later is one the employee may have already read and agreed to.
   */
  const [websiteTracking, setWebsiteTracking] = useState<UrlFidelity>("window-title");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = agentBridge();
    if (bridge === null) return;

    let live = true;

    bridge
      .getPolicy()
      .then((value) => {
        if (live) setPolicy(value);
      })
      .catch(() => {
        // The list below reads correctly without the intervals; losing them is worth
        // less than blocking the gate on a call that failed.
        if (live) setPolicy(null);
      });

    bridge
      .getPermissions()
      .then((value) => {
        if (live) setWebsiteTracking(value.websiteTracking);
      })
      .catch(() => {
        // Failing towards the narrower promise, for the same reason as the seed above.
      });

    return () => {
      live = false;
    };
  }, []);

  async function accept(): Promise<void> {
    const bridge = agentBridge();
    if (bridge === null || !agreed || busy) return;

    setBusy(true);
    setError(null);

    try {
      onAccepted(await bridge.acceptConsent());
    } catch (cause) {
      setError(
        bridgeErrorMessage(
          cause,
          "Your consent could not be recorded. Nothing has started. Check your connection and try again.",
        ),
      );
      setBusy(false);
    }
  }

  function decline(): void {
    // Not a dismissal. With no consent on file the agent has nothing it is permitted
    // to do, so it exits instead of sitting in the tray implying otherwise.
    void agentBridge()?.quit();
  }

  return (
    <Shell
      heading="Before monitoring starts"
      footer={
        <>
          {/* Pinned with the buttons, not with the body: the gate scrolls, and an
              employee who just pressed Accept is looking at the bottom of it. */}
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              disabled={busy}
            />
            <span>
              I have read this and I agree to be monitored while I am working on this device.
            </span>
          </label>

          <div className="actions">
            <button
              className="button button--quiet"
              type="button"
              onClick={decline}
              disabled={busy}
            >
              Decline and quit
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => void accept()}
              disabled={!agreed || busy}
            >
              {/* "Recording…" on its own read as monitoring having started — on the
                  one screen whose entire claim is that nothing has. */}
              {busy ? "Recording your consent…" : "Accept and start"}
            </button>
          </div>
        </>
      }
    >
      <p className="prose prose--body">
        This computer is managed by your employer. Once you accept, the AEMS agent records the
        following while it runs. Nothing below is collected until then.
      </p>

      <ul className="consent-list">
        {collectedItems(status, policy, websiteTracking).map((item) => (
          <li className="consent-list__item" key={item.id}>
            <p className="consent-list__title">{item.title}</p>
            <p className="consent-list__detail">{item.detail}</p>
          </li>
        ))}
      </ul>

      <ul className="consent-terms">
        <li>
          A tray icon stays visible for as long as the agent runs. Monitoring is never silent.
        </li>
        <li>
          You can withdraw your consent at any time from the AEMS web dashboard. Collection on this
          device stops at its next request.
        </li>
        <li>You can read everything recorded about you in the same dashboard.</li>
      </ul>

      {policy !== null && (
        <p className="meta">
          {policy.name} · version {policy.version}
        </p>
      )}
    </Shell>
  );
}

/**
 * What the agent records on *this* machine, in plain terms.
 *
 * The wording lives in `@aems/types` rather than here, because the dashboard shows the
 * same list to the same employee and two hardcoded copies of it drift — at which point
 * one of them is lying and neither is trustworthy. This screen supplies the two policy
 * numbers and the one platform fact the copy is parameterised by, and nothing else.
 *
 * The list is the device's permitted set, not the vocabulary: a type an administrator
 * has switched off is not shown, because asking somebody to agree to something that
 * will not happen is not disclosure. This is the same rule the Windows website line
 * already followed for a different reason — a promise the machine cannot keep is
 * dropped rather than printed — and it is why the two are now one code path.
 */
function collectedItems(
  status: AgentStatus,
  policy: AgentPolicy | null,
  websiteTracking: UrlFidelity,
) {
  return describeDataTypes(consentTypes(status), {
    screenshotInterval: policy === null ? null : formatSpan(policy.screenshotIntervalSeconds),
    idleThreshold: policy === null ? null : formatSpan(policy.idleThresholdSeconds),
    readsBrowserAddress: websiteTracking === "browser-url",
  });
}
