import type { ReactElement, ReactNode } from "react";

import type { Tone } from "../lib/view.js";

/**
 * The label/value grid docs/design.md specifies for the agent.
 *
 * A description list rather than a table: these are properties of one thing, so a
 * screen reader should announce "Status, Connected" and not walk a grid of cells.
 */
export function Readout({ children }: { children: ReactNode }): ReactElement {
  return <dl className="readout">{children}</dl>;
}

interface ReadoutRowProps {
  label: string;
  children: ReactNode;
  /** For values that are an absence — "Not tracked yet" — rather than a figure. */
  muted?: boolean;
}

export function ReadoutRow({ label, children, muted = false }: ReadoutRowProps): ReactElement {
  return (
    <div className="readout__row">
      <dt className="readout__label">{label}</dt>
      <dd className={muted ? "readout__value readout__value--muted" : "readout__value"}>
        {children}
      </dd>
    </div>
  );
}

/**
 * A state dot next to its own name.
 *
 * The word is always present. Colour alone would leave the single most important
 * fact in this window — whether monitoring is running — unreadable to anyone who
 * cannot separate emerald from amber.
 */
export function StatusValue({ tone, text }: { tone: Tone; text: string }): ReactElement {
  return (
    <span className="status-value">
      <span className={`dot dot--${tone}`} aria-hidden="true" />
      {text}
    </span>
  );
}
