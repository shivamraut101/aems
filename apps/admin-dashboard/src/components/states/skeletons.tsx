import { cn } from "@aems/ui";

/**
 * Loading placeholders, shaped like the thing that replaces them.
 *
 * The rule every primitive here obeys: **a skeleton occupies the same box as its
 * content**. A 120px grey bar standing in for a 500px page is not a loading state,
 * it is a layout shift with a pulse on it — the page collapses, then jumps back the
 * moment data lands, and it does that on every step through a date picker rather
 * than only on first load.
 *
 * The second rule lives in `view-state.ts`: none of these should be rendered for a
 * query that resolved from cache.
 *
 * `aria-hidden` throughout. A screen reader gets the surrounding "Loading…" status,
 * not a recitation of forty empty bars.
 */

/** One pulsing bar. `width` is a Tailwind class so callers stay in the design system. */
export function SkeletonBar({ className }: { className?: string }) {
  return <span className={cn("block h-4 animate-pulse rounded bg-muted", className)} aria-hidden />;
}

/** Stacked bars of decreasing width — a paragraph that has not arrived. */
export function SkeletonLines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="block h-4 animate-pulse rounded bg-muted"
          style={{ width: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  );
}

/**
 * A bordered panel of a fixed height with content-shaped bars inside.
 *
 * `minHeightClass` is required rather than defaulted: the whole point is to match
 * the panel it stands in for, and a default would quietly be wrong everywhere.
 */
export function PanelSkeleton({
  minHeightClass,
  lines = 3,
  title = true,
  className,
  label,
}: {
  minHeightClass: string;
  lines?: number;
  /** Draw a short heading bar above the lines. */
  title?: boolean;
  className?: string;
  /** Announced to assistive tech in place of the bars. */
  label?: string;
}) {
  return (
    <section
      aria-busy="true"
      {...(label ? { "aria-label": label } : {})}
      className={cn("rounded-lg border bg-card p-5", minHeightClass, className)}
    >
      {title ? <SkeletonBar className="mb-4 w-40" /> : null}
      <SkeletonLines count={lines} />
    </section>
  );
}

/** The filter row above a table: a search field, two selects, a columns button. */
export function FilterBarSkeleton({
  fields = 3,
  trailing = true,
  className,
}: {
  fields?: number;
  /** Draw the right-aligned control (the "Columns" menu on /devices). */
  trailing?: boolean;
  className?: string;
}) {
  const widths = ["w-72", "w-40", "w-36", "w-32"];

  return (
    <div className={cn("mb-4 flex flex-wrap items-end gap-2", className)} aria-hidden>
      {Array.from({ length: fields }, (_, index) => (
        <div
          key={index}
          className={cn(
            "h-9 animate-pulse rounded-md border border-input bg-muted/50",
            widths[index] ?? "w-32",
          )}
        />
      ))}
      {trailing ? (
        <div className="ml-auto h-9 w-28 animate-pulse rounded-md border border-input bg-muted/50" />
      ) : null}
    </div>
  );
}

/**
 * A column of the table being stood in for.
 *
 * `lines: 2` is not decoration — the device and person columns render a name plus a
 * secondary line, so a one-line placeholder there is a row that grows when data
 * lands. Anything measuring reserves `tabular` width and sits right-aligned.
 */
export interface SkeletonColumn {
  key: string;
  /** The real header text. Rendered, so the header does not appear on data landing. */
  label: string;
  align?: "left" | "right";
  lines?: 1 | 2;
  /** Tailwind width for the primary bar, e.g. `"w-32"`. */
  width?: string;
}

/**
 * Body rows only, for a table whose `<thead>` is already rendered.
 *
 * /devices builds its header from TanStack Table and keeps it up while loading, so
 * it needs the rows without a second header — hence this being separate from
 * {@link TableSkeleton} rather than a flag on it.
 */
export function TableSkeletonRows({
  columns,
  rows = 5,
}: {
  columns: readonly SkeletonColumn[];
  rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex} className="border-b last:border-0" aria-hidden>
          {columns.map((column, columnIndex) => (
            <td
              key={column.key}
              className={cn("px-4 py-2.5 align-top", column.align === "right" && "text-right")}
            >
              <span
                className={cn(
                  "inline-block h-3.5 animate-pulse rounded bg-muted align-middle",
                  column.width ?? (columnIndex === 0 ? "w-36" : "w-20"),
                )}
              />
              {column.lines === 2 ? (
                <span className="mt-1.5 block h-2.5 w-24 animate-pulse rounded bg-muted/60" />
              ) : null}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * A whole table — real `<thead>`, skeleton `<tbody>` — inside the bordered card the
 * loaded table uses.
 *
 * Used as a route-level fallback, where nothing has rendered yet and the header has
 * to come from somewhere.
 */
export function TableSkeleton({
  columns,
  rows = 5,
  caption,
  minWidthClass = "min-w-[52rem]",
  className,
}: {
  columns: readonly SkeletonColumn[];
  rows?: number;
  /** Screen-reader caption. Says what is loading, since the bars say nothing. */
  caption: string;
  minWidthClass?: string;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border bg-card", className)} aria-busy="true">
      <table className={cn("w-full text-sm", minWidthClass)}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn("px-4 py-2 font-medium", column.align === "right" && "text-right")}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <TableSkeletonRows columns={columns} rows={rows} />
        </tbody>
      </table>
    </div>
  );
}

/**
 * A vertical list of people or rows — the Activity roster while it loads.
 *
 * Two lines per entry because a roster row carries a name and a status line, and a
 * single bar makes the list half its final height.
 */
export function ListSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <ul className={cn("divide-y", className)} aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="block h-3.5 w-32 animate-pulse rounded bg-muted" />
            <span className="block h-3 w-14 animate-pulse rounded bg-muted/60" />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="block h-3 w-16 animate-pulse rounded bg-muted/60" />
            <span className="block h-3 w-20 animate-pulse rounded bg-muted/60" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A row of KPI cells, matching the bordered grid the loaded page draws. */
export function StatGridSkeleton({ cells = 3, className }: { cells?: number; className?: string }) {
  return (
    <div
      className={cn("grid gap-px overflow-hidden rounded-lg border bg-border", className)}
      style={{ gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))` }}
      aria-hidden
    >
      {Array.from({ length: cells }, (_, index) => (
        <div key={index} className="bg-card px-4 py-3">
          <span className="block h-3 w-16 animate-pulse rounded bg-muted/60" />
          <span className="mt-2 block h-6 w-20 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
