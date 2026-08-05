/**
 * Layout primitives for /settings.
 *
 * Settings is a reference screen, not a dashboard: `docs/design.md` reserves cards
 * for KPIs, so configuration reads as headed sections over dense definition lists
 * and one table. Four floating cards here would be exactly the card farm it warns
 * against.
 */

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9 first:mt-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function DefinitionList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="divide-y overflow-hidden rounded-lg border bg-card text-sm">{children}</dl>
  );
}

export function DefinitionRow({
  term,
  children,
  hint,
}: {
  term: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5">
      <dt className="w-44 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="min-w-0 flex-1">
        {children}
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </dd>
    </div>
  );
}

/** A loading line that occupies the space its value will, so nothing jumps. */
export function ValueSkeleton({ className = "w-32" }: { className?: string }) {
  return <span className={`block h-4 animate-pulse rounded bg-muted ${className}`} />;
}

/**
 * An empty or unavailable state.
 *
 * Deliberately not styled as an error unless it is one — on day one of a demo almost
 * every panel is empty, and "no data yet" must not look like a fault.
 */
export function Notice({
  tone = "muted",
  title,
  children,
}: {
  tone?: "muted" | "warning" | "error";
  title: string;
  children?: React.ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-destructive/30 bg-destructive/5"
      : tone === "warning"
        ? "border-warning/40 bg-warning/5"
        : "border-border bg-card";

  return (
    <div className={`rounded-lg border px-4 py-3.5 ${toneClass}`}>
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

/**
 * One control's chrome, shared by every input and select on this screen.
 *
 * `packages/ui` has Button, Card and Badge and nothing else, and `docs/stack.md`
 * locks the component library — so a settings form styles native controls rather
 * than pulling in a second one. 8px radius and a thin border, per `docs/design.md`.
 */
export const controlClass =
  "h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A labelled control with room for a hint and a validation message.
 *
 * The error is wired through `aria-describedby` and announced with `role="alert"`:
 * a refusal a screen reader never reads is a refusal that did not happen.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className = "",
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Dense two-column form grid that collapses to one column on a narrow viewport. */
export function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">{children}</div>;
}
