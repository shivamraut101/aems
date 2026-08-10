// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectionOff, type CollectionOffType } from "./feedback";

/**
 * A monitoring product has three reasons a figure can be missing and they are not
 * interchangeable. These pin the properties that keep this one apart from the other
 * two — it names a person and a date, it never appears without a decision behind it,
 * and it says the words the platform-cannot states are not allowed to.
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

const type = (
  label: string,
  byName: string | null = "Sam Patel",
  atISO: string | null = "2026-08-08T09:30:00.000Z",
): CollectionOffType => ({ label, byName, atISO });

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

describe("CollectionOff", () => {
  it("says nothing when nothing was switched off", () => {
    // What lets every surface render it unconditionally instead of guarding the block,
    // and what makes a failed or pending settings read produce silence rather than a
    // false claim that collection has stopped.
    render(<CollectionOff types={[]} />);
    expect(container.textContent).toBe("");
  });

  it("names who switched it off and when", () => {
    render(<CollectionOff types={[type("Screenshots")]} />);

    const text = container.textContent ?? "";
    expect(text).toContain("Screenshots is switched off");
    expect(text).toContain("Sam Patel");
    // The machine-readable date, so the rendered wording can be localised without the
    // timestamp becoming unverifiable.
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T09:30:00.000Z",
    );
  });

  it("is not one of the other two missing-data states", () => {
    // `phone-day.tsx` and `devices-view.tsx` own "Not reported" / "None reported" for
    // a platform that cannot answer. Reusing either here would collapse the very
    // distinction this component was added to draw.
    render(<CollectionOff types={[type("Idle time")]} />);

    const text = container.textContent ?? "";
    expect(text).not.toContain("Not reported");
    expect(text).not.toContain("None reported");
    expect(text).toContain("recorded decision, not a gap");
  });

  it("still states the decision when the administrator has left", () => {
    // `changed_by` is `on delete set null`, so the row outlives the person. A missing
    // name must not silently drop the whole attribution line.
    render(<CollectionOff types={[type("Websites", null)]} />);

    const text = container.textContent ?? "";
    expect(text).toContain("no longer listed");
    expect(text).toContain("Switched off by");
  });

  it("lists several types in one notice, and names the machines when asked", () => {
    render(
      <CollectionOff
        types={[type("Screenshots"), type("Idle time"), type("Websites")]}
        scopes={["John's laptop"]}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Screenshots, Idle time and Websites are switched off on John's laptop");
    // One line per type, because two administrators' two decisions on two days must
    // not both read as the later one.
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("drops the per-type list when compact, keeping the sentence", () => {
    render(<CollectionOff types={[type("Screenshots")]} compact />);

    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(container.textContent).toContain("Screenshots is switched off");
  });

  it("is amber only for the person it was decided about", () => {
    // Neutral on manager-facing screens: a correctly recorded decision is not an
    // incident, and amber there would read as one.
    render(<CollectionOff types={[type("Screenshots")]} />);
    expect(container.querySelector("div")?.className).not.toContain("warning");

    render(<CollectionOff types={[type("Screenshots")]} tone="subject" />);
    expect(container.querySelector("div")?.className).toContain("warning");
  });
});
