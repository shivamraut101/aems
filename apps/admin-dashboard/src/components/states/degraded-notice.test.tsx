// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DegradedNotice } from "./feedback";

/**
 * The Devices page reads three sources and used to raise one amber strip per failure,
 * so a bad minute buried the table under three paragraphs and three Retry links.
 * These pin the two properties that made one line enough.
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

const source = (label: string, isError: boolean, refetch = vi.fn()) => ({ label, isError, refetch });

function render(sources: Parameters<typeof DegradedNotice>[0]["sources"]) {
  act(() => root.render(<DegradedNotice sources={sources} />));
}

describe("DegradedNotice", () => {
  it("says nothing at all while every source is healthy", () => {
    // What lets a caller list all its sources unconditionally instead of guarding each.
    render([source("This inventory", false), source("Assigned to", false)]);
    expect(container.textContent).toBe("");
  });

  it("collapses several failures into one sentence", () => {
    render([
      source("This inventory", true),
      source("Battery, network and free storage", false),
      source("Assigned to", true),
    ]);

    const text = container.textContent ?? "";
    expect(text).toContain("This inventory and Assigned to");
    // The healthy source is not named — listing what still works would make the line
    // as long as the pile of banners it replaced.
    expect(text).not.toContain("Battery");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("retries every failed source at once, and no healthy one", () => {
    // Three buttons made the reader schedule the recovery. The screen knows which
    // sources are down, so it can ask for all of them.
    const broken = vi.fn();
    const alsoBroken = vi.fn();
    const healthy = vi.fn();

    render([
      source("This inventory", true, broken),
      source("Assigned to", true, alsoBroken),
      source("Battery", false, healthy),
    ]);

    act(() => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(broken).toHaveBeenCalledOnce();
    expect(alsoBroken).toHaveBeenCalledOnce();
    expect(healthy).not.toHaveBeenCalled();
  });

  it("reads as a singular for one failure", () => {
    render([source("Assigned to", true)]);
    expect(container.textContent).toContain("Assigned to is not current");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
});
