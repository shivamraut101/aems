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
 *
 * Exported so the hover rules can be asserted on. They encode a compliance guarantee
 * rather than a preference, and jsdom has no hover state to test them through.
 */
export const INDICATOR_CSS = `
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
  transition: opacity 140ms ease;
}

/*
 * Hover fades the whole pill to 20%.
 *
 * The pill sits in the bottom-right of the work area, which is also where a status
 * bar and half the world's toolbar buttons live, so it will sometimes cover something
 * the employee is reading. Moving the cursor onto it takes it almost out of the way.
 *
 * One property on one element, deliberately. An earlier version cleared the panel,
 * hid the label and slid the dot to the far corner with row-reverse — three things
 * moving at once, which lurched, and which was not what was asked for either. Fading
 * the container means nothing changes size or position and there is nothing to
 * glitch.
 *
 * 20% rather than 0: non-negotiable #2 is that monitoring is never silent, and an
 * indicator an employee can switch off by resting the cursor on it is a dismissable
 * indicator. At 20% the pill is still perceptible against any backdrop, the tray icon
 * is unaffected, and it returns to full strength the moment the pointer leaves.
 *
 * This works only because main/indicator.ts passes { forward: true } to
 * setIgnoreMouseEvents — the window is click-through, and that flag is the reason
 * mouse-move messages still reach this page. Dropping it disables the rule below with
 * no error and no failing test.
 *
 * NOTE: this stylesheet lives inside a JavaScript template literal, so a backtick
 * anywhere in it — including in a comment — terminates the string and the renderer
 * stops building. That has already happened once.
 */
.indicator:hover {
  opacity: 0.2;
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
  transition: opacity 140ms ease;
}

/*
 * docs/design.md rules out heavy animation, and this is already only a 140ms cross-fade
 * — but the employee's own accessibility setting outranks a nicety either way. The
 * hover state itself still applies; it just arrives at once.
 */
@media (prefers-reduced-motion: reduce) {
  .indicator,
  .indicator__dot,
  .indicator__label {
    transition: none;
  }
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
      <style>{INDICATOR_CSS}</style>
      {state.visible && (
        <div className="indicator">
          <span className={`indicator__dot indicator__dot--${state.tone}`} />
          <span className="indicator__label">{state.label}</span>
        </div>
      )}
    </>
  );
}
