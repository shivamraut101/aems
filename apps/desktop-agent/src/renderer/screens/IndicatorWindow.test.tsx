// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INDICATOR_CSS, IndicatorWindow } from "./IndicatorWindow.js";

/**
 * The always-visible indicator — non-negotiable #2, at the pixel.
 *
 * Two different things are under test here and they need different instruments.
 *
 * The markup is testable normally: with no bridge on `window`, the component falls back
 * to its seed state, which is the state that matters most — it is what the employee sees
 * in the gap between the window being raised and the first IPC reply, and rendering
 * nothing there would blank the compliance signal for exactly as long as that takes.
 *
 * The hover rules are not. jsdom has no pointer and no `:hover`, and the window they
 * live in is click-through, so no test in this repo can drive them; they were checked
 * against a real engine over both a dark editor and a white document, via CDP's
 * `CSS.forcePseudoState`. What is left for a unit test is the one property that must
 * survive every future edit, and it is a property of the stylesheet itself: hover may
 * shrink the indicator, never erase it. Asserting on the CSS text is a blunt instrument,
 * and it is the only one that reaches this.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => root.render(<IndicatorWindow />));
}

describe("IndicatorWindow", () => {
  it("claims monitoring before any status has arrived", () => {
    render();

    // Main only builds this window while collection is running, so its mere existence
    // is already the claim; the first paint has to honour that rather than wait.
    expect(container.querySelector(".indicator__label")?.textContent).toBe("Monitoring");
    expect(container.querySelector(".indicator__dot--recording")).not.toBeNull();
  });
});

describe("the hover rules", () => {
  /** Every declaration inside the `.indicator:hover` block, whitespace-insensitive. */
  const hoverBlock = (): string => {
    const match = /\.indicator:hover\s*\{([^}]*)\}/.exec(INDICATOR_CSS);
    expect(match?.[1], "the .indicator:hover rule has been removed").toBeTypeOf("string");
    return match?.[1] ?? "";
  };

  it("clears the panel, so the pill stops covering what is underneath", () => {
    // The whole point of the change: the navy slab is 184x32 of an employee's screen
    // and it sits over the corner of whatever they are reading.
    expect(hoverBlock()).toMatch(/background:\s*transparent/);
  });

  it("never fades the indicator itself", () => {
    // The one rule that must not be broken. `opacity` here would cascade to the dot,
    // and an indicator an employee can switch off by resting the cursor on it is a
    // dismissable indicator — which is precisely what non-negotiable #2 forbids.
    // Fade the panel and the label individually; never the container.
    expect(hoverBlock()).not.toMatch(/opacity/);
    expect(hoverBlock()).not.toMatch(/display:\s*none/);
    expect(hoverBlock()).not.toMatch(/visibility:\s*hidden/);
  });

  it("leaves the dot fully opaque and ringed", () => {
    const dot = /\.indicator:hover\s+\.indicator__dot\s*\{([^}]*)\}/.exec(INDICATOR_CSS);
    const body = dot?.[1] ?? "";
    expect(body, "the dot is what carries the signal once the panel is gone").not.toBe("");

    // A ring in both directions: the dot loses the navy panel it was reading against
    // and has to hold up over a white document as well as a dark editor.
    expect(body).toMatch(/box-shadow/);
    expect(body).not.toMatch(/opacity/);
  });

  it("keeps the tone colours out of the hover rules", () => {
    // Amber means "monitoring, limited" and emerald means "recording". If hover could
    // restyle either, the indicator could tell the employee the wrong thing about what
    // is being collected — worse than covering their screen.
    expect(INDICATOR_CSS).not.toMatch(/\.indicator:hover[^{]*--recording/);
    expect(INDICATOR_CSS).not.toMatch(/\.indicator:hover[^{]*--limited/);
  });
});
