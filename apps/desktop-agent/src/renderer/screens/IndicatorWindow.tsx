import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { AgentStatus, IndicatorState } from "../../shared/types/index.js";
import { indicatorStateFor } from "../../shared/types/index.js";
import { agentBridge } from "../lib/bridge.js";

/**
 * What the always-on-top indicator paints before any status has arrived.
 *
 * Main only creates this window while collection is running, so the window merely
 * existing is already the claim. Rendering nothing until the first IPC round trip
 * would blank the compliance signal for as long as that takes.
 */
const INITIAL: IndicatorState = { visible: true, tone: "recording", label: "Monitoring" };

/**
 * The pill itself.
 *
 * It carries its own stylesheet rather than leaning on `styles.css`, for two reasons:
 * the shared sheet paints an opaque page background, which would fill this window's
 * transparency edge to edge; and the indicator has to stay legible over an arbitrary
 * desktop, so it fixes its colours instead of following the system theme.
 *
 * A status light, not a widget: one dot, two words, no animation. docs/design.md
 * reserves indigo for AI output, so the tones here are emerald and amber only.
 */
const CSS = `
html, body, #root {
  height: 100%;
  margin: 0;
  background: transparent !important;
  overflow: hidden;
}

.indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: 100%;
  padding: 0 12px;
  border: 1px solid rgb(226 232 240 / 16%);
  border-radius: 8px;
  background: #0f172a;
  color: #f8fafc;
  font-family: Inter, "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.01em;
  white-space: nowrap;
  user-select: none;
  cursor: default;
}

.indicator__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.indicator__dot--recording {
  background: #10b981;
}

.indicator__dot--limited {
  background: #f59e0b;
}

.indicator__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

export function IndicatorWindow(): ReactElement {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    const bridge = agentBridge();
    if (bridge === null) return;

    let live = true;

    const unsubscribe = bridge.onStatusChanged((next) => {
      if (live) setStatus(next);
    });

    // The push channel only fires on a change, so an indicator raised between two
    // changes would sit on the seed state until the next one.
    bridge
      .getStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => {
        // Deliberately silent: this window has nowhere to report an error to, and
        // INITIAL is already the honest reading of "main decided to show me".
      });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const state = status === null ? INITIAL : indicatorStateFor(status);

  return (
    <>
      <style>{CSS}</style>
      {state.visible && (
        <div className="indicator">
          <span className={`indicator__dot indicator__dot--${state.tone}`} />
          <span className="indicator__label">{state.label}</span>
        </div>
      )}
    </>
  );
}
