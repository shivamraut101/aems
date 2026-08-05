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
  transition: background-color 140ms ease, border-color 140ms ease;
}

/*
 * Hover fades the panel, never the signal.
 *
 * The pill sits in the bottom-right corner of the work area, which is also where a
 * status bar, a notification tray and half the world's toolbar buttons live — so it
 * will sometimes cover something the employee is trying to read. Moving the cursor
 * onto it drops the navy slab to a wash and lets that through.
 *
 * What it must not do is vanish. Non-negotiable #2 is that monitoring is never
 * silent, and an indicator an employee can dismiss by resting the cursor on it is a
 * dismissable indicator — so nothing here touches .indicator's own opacity, which
 * would take the dot and the label down with it. The two parts that carry the meaning
 * are instead re-styled to survive without the panel behind them: the dot keeps its
 * full colour and gains a ring, and the label keeps a shadow. Both are needed because
 * once the slab is gone the backdrop is an arbitrary desktop — #f8fafc text over a
 * white document is invisible without the shadow, and an emerald dot on a pale
 * background is weak without the ring.
 *
 * Hover changes how much of the screen the pill covers. It does not change whether
 * the pill is on screen.
 *
 * This works only because main/indicator.ts passes { forward: true } to
 * setIgnoreMouseEvents — the window is click-through, and that flag is the reason
 * mouse-move messages still reach this page. Dropping it silently disables every
 * rule below, with no error anywhere.
 *
 * NOTE: this whole stylesheet lives inside a JavaScript template literal, so a
 * backtick anywhere in it — including in a comment — terminates the string and the
 * renderer stops building. That is exactly what happened here.
 */
.indicator:hover {
  border-color: transparent;
  background: transparent;
  /*
   * The dot retreats to the corner rather than staying where the pill's left edge was.
   *
   * The window is anchored to the bottom-right of the work area, so its right edge is
   * the screen corner and its left edge is 184px into whatever the employee is reading.
   * Leaving the dot there would clear the panel and then park the one remaining opaque
   * thing in the middle of the text. row-reverse costs nothing and is robust to
   * INDICATOR_SIZE changing, which a hard-coded translate would not be.
   */
  flex-direction: row-reverse;
}

.indicator__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: box-shadow 140ms ease;
}

.indicator:hover .indicator__dot {
  /* A ring, because the dot loses the navy panel it was reading against and has to
     hold up over a white document as well as a dark editor. */
  box-shadow: 0 0 0 2px rgb(2 6 23 / 55%), 0 0 0 3px rgb(248 250 252 / 45%);
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
 * The label goes, the dot stays.
 *
 * A half-faded label does not solve the problem it was meant to: white text at 70%
 * over whatever text is underneath produces two overlapping strings and neither is
 * readable, so the employee still cannot see what the pill is covering. Removing it
 * outright is what actually clears the corner.
 *
 * The dot is then carrying non-negotiable #2 on its own, which it can: it keeps its
 * full colour, it is never removed from the layout, the window is still on screen and
 * still on top, the tray icon is unaffected, and the full pill comes back the instant
 * the pointer moves away. What an employee gets by hovering is a smaller indicator
 * for as long as they hold the cursor there — not a way to turn one off.
 */
.indicator:hover .indicator__label {
  opacity: 0;
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
