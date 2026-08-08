import { Skeleton, cn } from "@aems/ui";
import { AlertTriangle, Check } from "lucide-react";

/**
 * Layout primitives for /settings.
 *
 * Settings is a reference screen, not a dashboard: `docs/design.md` reserves cards for
 * KPIs, so configuration reads as headed sections over dense definition lists and
 * tables. Four floating cards here would be exactly the card farm it warns against.
 *
 * What used to live here and no longer does: `Field`, `FieldGrid` and a `controlClass`
 * string. `packages/ui` now exports `Field`, `Input`, `Select`, `Switch` and
 * `Checkbox`, and a settings screen styling its own native controls beside them is how
 * two of the seven competing control styles in this app came to exist. The forms in
 * this directory use the shared primitives; only the section chrome is local.
 */

export function Section({
  title,
  description,
  affects,
  actions,
  children,
  id,
}: {
  title: string;
  description?: string;
  /**
   * Who a change here lands on, in one clause.
   *
   * A separate line rather than a third sentence in `description`, because this screen
   * is four unrelated jobs stacked in one scroll and the question a reader has at each
   * heading is "whose machine does this touch". Buried in the prose it is read once;
   * on its own line it is scannable down the page.
   */
  affects?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    // `scroll-mt` so the in-page index below the sticky heading does not land a target
    // underneath it.
    <section id={id} className="mt-9 scroll-mt-4 first:mt-0">
      {/* `items-end` only once the row is side by side: stacked on a phone it would
          right-align the action under a left-aligned heading. */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
          {affects ? (
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Affects</span> {affects}
            </p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
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

/**
 * One term and its value.
 *
 * The term is full width below `sm` and a fixed column above it. A `w-44` term at
 * 375px left about 150px for the value, so a company name or an error sentence wrapped
 * to four lines against a short label — legible, but not a definition list.
 */
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
    <div className="gap-x-4 px-4 py-2.5 sm:flex sm:flex-wrap sm:items-baseline">
      <dt className="text-muted-foreground sm:w-44 sm:shrink-0">{term}</dt>
      <dd className="mt-0.5 min-w-0 sm:mt-0 sm:flex-1">
        {children}
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </dd>
    </div>
  );
}

/** A loading line that occupies the space its value will, so nothing jumps. */
export function ValueSkeleton({ className = "w-32" }: { className?: string }) {
  return <Skeleton className={cn("h-4", className)} />;
}

/**
 * An empty or unavailable state.
 *
 * Deliberately not styled as an error — on day one of a demo almost every panel is
 * empty, and "no data yet" must not look like a fault.
 *
 * There is no `error` tone. It existed, and it drew a destructive box with no way out
 * of it: every failure on this screen was a sentence and a dead end. A failed read is
 * `ErrorState` from `@/components/states`, which carries the retry, and having one of
 * them rather than two is what stops a retry being optional.
 */
export function Notice({
  tone = "muted",
  title,
  children,
}: {
  tone?: "muted" | "warning";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3.5",
        tone === "warning" ? "border-warning/40 bg-warning/5" : "border-border bg-card",
      )}
    >
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

/**
 * The sentence shown after a write the server has confirmed.
 *
 * A badge flipping is not feedback — it is indistinguishable from a stale render, and
 * on controls this consequential "did that work?" is a question the screen has to
 * answer out loud.
 */
export function Confirmation({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="mb-3 flex items-start gap-2.5 rounded-lg border border-success/40 bg-success/5 px-4 py-3"
    >
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

/**
 * "Are you sure, and here is what happens" — the inline confirmation every
 * consequential control on this screen uses instead of a modal.
 *
 * Inline rather than a dialog because the row being changed stays visible: a modal
 * asking "pause monitoring?" hides the name of the person it is about.
 *
 * The action buttons are `h-9` rather than the `size="sm"` `h-8` used elsewhere in the
 * app. 36px is the smallest comfortable touch target, and these are the buttons where
 * a mis-tap has a consequence.
 */
export function ConfirmPanel({
  title,
  detail,
  error,
  children,
}: {
  title: React.ReactNode;
  detail: React.ReactNode;
  error?: string | null;
  /** The buttons. Cancel first, then the confirming action. */
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <AlertTriangle className="mt-0.5 hidden h-4 w-4 shrink-0 text-warning sm:block" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {/* A div, not a p: callers pass a diff list, and a ul inside a p is invalid HTML. */}
        <div className="mt-0.5 text-sm text-muted-foreground">{detail}</div>
        {error ? (
          <p role="alert" className="mt-1.5 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** Dense two-column form grid that collapses to one column on a narrow viewport. */
export function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">{children}</div>;
}

/** The bordered panel a form sits in, inside a section. */
export function FormPanel({
  title,
  description,
  onSubmit,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <form className={cn("rounded-lg border bg-card px-4 py-4", className)} onSubmit={onSubmit}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? (
        <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </form>
  );
}
