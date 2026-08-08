import { cn } from "@aems/ui";
import { AlertTriangle, Inbox } from "lucide-react";

/**
 * Loading, empty and error, as three explicit surfaces.
 *
 * Day one of a deployment has almost no data, so "nothing here" is the *normal* state
 * of this page for a while. A blank panel reads as a bug; a panel that says what is
 * missing and why reads as a product. Shared across the seven tabs so all seven fail
 * and empty the same way.
 */

/*
 * The switched-off state is not redeclared here.
 *
 * Re-exported from the shared module instead, so the seven employee tabs and the
 * screens that import from `@/components/states` render the same component. A second
 * copy of *this* state would be a compliance defect rather than a cosmetic one: two
 * implementations means one of them eventually stops naming who turned a data type
 * off, on half the surfaces, with nothing to notice it.
 */
export { CollectionOff, type CollectionOffType } from "@/components/states";

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * A bordered panel — the container every section on this page sits in.
 *
 * The shadow is the token, not a value: `--shadow-sm` is defined for both themes, so
 * the panels here sit at the same elevation as the cards on Overview and `/me` instead
 * of reading as the one flat surface in the product.
 */
export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)]", className)}>
      {children}
    </section>
  );
}

/**
 * Nothing to show, and a reason.
 *
 * `action` carries the way out — usually a link to the previous day, because the most
 * common cause of an empty day is looking at the wrong one.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <Inbox className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * A failed request, described to the person rather than to the developer.
 *
 * `message` must come from `describeError`. Rendering a raw `error.message` is how a
 * 401 ended up being reported as "check that the API is running" — an authentication
 * problem sending the reader to the wrong place entirely.
 */
export function ErrorState({
  title = "Could not load this",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3.5"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
        {title}
      </p>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        // `h-9` rather than the padding that used to size it: measured at 375px this
        // button rendered 26px tall, and a retry a thumb misses is the one control on
        // a failed screen that has to be hittable.
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Placeholder bars sized like the content they stand in for. */
export function SkeletonLines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="block h-4 animate-pulse rounded bg-muted"
          style={{ width: `${100 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

/**
 * "These numbers are a floor."
 *
 * The API returns `truncated` when a row cap was hit. A total that silently omits
 * half a day is worse than one that admits it is partial, so this is never hidden.
 */
export function TruncationNotice() {
  return (
    <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span>
        This day had more activity than one request returns. The figures below are a
        floor, not a total — narrow the range to see all of it.
      </span>
    </p>
  );
}
