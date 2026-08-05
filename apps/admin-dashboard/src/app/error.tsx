"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

/**
 * The route-level error boundary. There was none anywhere in this app.
 *
 * Without this file a thrown render exception gets React's own handling — in
 * production that is the bare string "Application error: a client-side exception has
 * occurred", on a blank white page, with the sidebar gone and no way back. For an
 * operations tool that is indistinguishable from the product being down.
 *
 * This renders inside the root layout, so the shell and its navigation survive: the
 * failure is scoped to the page, and every other screen is one click away.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on a minified production stack. Log the whole
    // error client-side; the surface below shows the reader nothing internal.
    console.error("Unhandled error in a dashboard route", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <div
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-5"
      >
        <p className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
          This screen could not be rendered
        </p>

        <p className="mt-2 text-sm text-muted-foreground">
          Something in this page failed while it was drawing. Nothing was changed, and
          the rest of the dashboard is unaffected — try again, or move to another
          screen.
        </p>

        {error.digest ? (
          <p className="tabular mt-3 text-xs text-muted-foreground">
            Reference <span className="font-medium">{error.digest}</span> — quote this
            when reporting it.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
