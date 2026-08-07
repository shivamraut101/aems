import { cn } from "@aems/ui";
import { AlertTriangle, Inbox, RotateCw } from "lucide-react";

/**
 * Empty and error, as two visibly different surfaces.
 *
 * They are separated on purpose. "Nothing has happened yet" is the *normal* state of
 * a monitoring product on its first day, and drawing it the same way as "we could not
 * reach the service" teaches a reader to ignore both. Empty is quiet and explains
 * what would put something here; error is bordered in destructive, carries
 * `role="alert"`, names what failed, and offers the retry.
 *
 * Modelled on `components/employee/states.tsx`, which shipped first for the employee
 * tabs. This module is the shared home — see the note at the bottom of the file.
 */

/**
 * Nothing to show, and a reason.
 *
 * `action` carries the way out — usually a link to a different day, because the
 * commonest cause of an empty screen is looking at the wrong one.
 */
export function EmptyState({
  title,
  body,
  action,
  className,
  bordered = true,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  className?: string;
  /** Off when the caller already draws the panel around it (a table cell, a card). */
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center px-6 py-10 text-center",
        bordered && "rounded-lg border bg-card",
        className,
      )}
    >
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
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3.5",
        className,
      )}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
        {title}
      </p>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCw className="h-3 w-3" aria-hidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * One line saying part of the screen is not current, with the rest of it left alone.
 *
 * The `"stale"` half of `resolveViewState`, and the answer to a specific defect: when
 * live presence failed, every person on the Activity roster rendered as "Offline". In
 * a monitoring product "we cannot reach presence" and "this person is not working"
 * must never look the same, and blanking the whole roster over it would be an
 * overreaction in the other direction.
 */
export function StaleNotice({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs",
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      ) : null}
    </p>
  );
}

/** One source a screen reads from, and what it costs the reader when it fails. */
export interface DegradedSource {
  /** Named as the reader sees it — a column or a section, never a request. */
  label: string;
  isError: boolean;
  refetch: () => void;
}

/**
 * Everything on this screen that is not current, as one line.
 *
 * Replaces stacking a {@link StaleNotice} per failed query. The Devices page reads
 * three sources — inventory, telemetry, roster — and rendered a separate amber strip
 * for each, so a bad minute pushed the table a third of the way down the page behind
 * three paragraphs and three Retry links. Each was individually well-written and the
 * pile was unreadable.
 *
 * Two rules make one line enough:
 *
 *  - **Name the columns, not the requests.** "Owner names could not be read" describes
 *    our architecture; "Assigned to" describes the reader's table. Nobody using this
 *    knows there are three queries and nobody should have to.
 *  - **One Retry, for everything that failed.** Three buttons made the reader schedule
 *    the recovery. The screen knows which sources are down; it can ask for all of them.
 *
 * Renders nothing when every source is healthy, which is what lets a caller list all
 * of them unconditionally rather than guarding each.
 */
export function DegradedNotice({
  sources,
  className,
}: {
  sources: readonly DegradedSource[];
  className?: string;
}) {
  const failed = sources.filter((source) => source.isError);
  if (failed.length === 0) return null;

  return (
    <p
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs",
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium">{formatList(failed.map((source) => source.label))}</span>{" "}
        {failed.length === 1 ? "is" : "are"} not current. Everything else on this page is.
      </span>
      <button
        type="button"
        onClick={() => {
          for (const source of failed) source.refetch();
        }}
        className="rounded font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {failed.length === 1 ? "Retry" : "Retry all"}
      </button>
    </p>
  );
}

/** "A", "A and B", "A, B and C" — Oxford-less, which is the house style in this UI. */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/*
 * Note for whoever consolidates this next.
 *
 * `components/employee/states.tsx` still declares its own `EmptyState`, `ErrorState`
 * and `SkeletonLines`. They are the same components and should be deleted there in
 * favour of a re-export from here, so the seven employee tabs and the three screens
 * below cannot drift apart. That file was outside this change's ownership, so the
 * merge is left as one small follow-up rather than done half-way.
 */
