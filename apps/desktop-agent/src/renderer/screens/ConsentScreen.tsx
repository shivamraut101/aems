import { useEffect, useState, type ReactElement } from "react";

import type { AgentPolicy, AgentStatus, UrlFidelity } from "../../shared/types/index.js";
import { Shell } from "../components/Shell.js";
import { agentBridge, bridgeErrorMessage } from "../lib/bridge.js";
import { formatSpan } from "../lib/format.js";

interface ConsentScreenProps {
  onAccepted: (status: AgentStatus) => void;
}

interface CollectedItem {
  title: string;
  detail: string;
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
export function ConsentScreen({ onAccepted }: ConsentScreenProps): ReactElement {
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
        {collectedItems(policy, websiteTracking).map((item) => (
          <li className="consent-list__item" key={item.title}>
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
 * What the agent records, in plain terms.
 *
 * Written against what the main-process modules actually do rather than against the
 * policy row, so a wording that drifts from the behaviour is a bug someone can see.
 * The negatives — keystrokes, page contents — are stated because their absence is
 * the part employees most often assume wrongly.
 */
function collectedItems(policy: AgentPolicy | null, websiteTracking: UrlFidelity): CollectedItem[] {
  const screenshotEvery =
    policy === null
      ? "at regular intervals"
      : `about every ${formatSpan(policy.screenshotIntervalSeconds)}`;
  const idleAfter =
    policy === null ? "for a few minutes" : `for ${formatSpan(policy.idleThresholdSeconds)}`;

  return [
    {
      title: "Applications you use",
      detail: "The name of the application in focus and how long it stays in focus.",
    },
    // Windows exposes no supported way to read a browser tab's address, so promising
    // one there would be a description of a capability this binary does not have —
    // on the single screen whose validity rests on the description being accurate.
    websiteTracking === "browser-url"
      ? {
          title: "Website domains you visit",
          detail:
            "The domain of the page open in your browser — github.com, for example — and the time spent there. Page contents are not read.",
        }
      : {
          title: "Not the websites you visit",
          detail:
            "This computer cannot report the addresses of pages you open, so no website activity is recorded from it. Your browser is recorded only as an application, by name and by how long it is in focus.",
        },
    {
      title: "Idle periods",
      detail: `When there has been no keyboard or mouse activity ${idleAfter}. What you type is never recorded — only whether input happened.`,
    },
    {
      title: "Screenshots",
      detail: `A picture of your screen ${screenshotEvery}, covering every display connected to this computer.`,
    },
    {
      title: "This device",
      detail:
        "Device name, operating system and version, CPU and memory, and the list of applications installed on it.",
    },
  ];
}
