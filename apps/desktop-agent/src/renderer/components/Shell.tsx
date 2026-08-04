import type { ReactElement, ReactNode } from "react";

interface ShellProps {
  /** Screen heading under the fixed product title. The status readout has none. */
  heading?: string;
  children: ReactNode;
  /** Pinned below the scroll area — where the actions of a long screen belong. */
  footer?: ReactNode;
}

/**
 * The frame every screen renders into.
 *
 * The product name is chrome rather than per-screen content: the window is 460px
 * wide and can be raised from the tray at any moment, so it has to identify itself
 * the instant it appears, including on the consent gate.
 */
export function Shell({ heading, children, footer }: ShellProps): ReactElement {
  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Company Monitor</h1>
        <p className="app__subtitle">AEMS workforce intelligence agent</p>
      </header>

      <main className="app__main">
        {heading !== undefined && <h2 className="screen__heading">{heading}</h2>}
        {children}
      </main>

      {footer !== undefined && <footer className="app__footer">{footer}</footer>}
    </div>
  );
}
