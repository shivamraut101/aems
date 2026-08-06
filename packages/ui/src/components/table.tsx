"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Table.
 *
 * Eighteen tables in the dashboard repeat the same header treatment
 * (`border-b text-left text-xs uppercase tracking-wide text-muted-foreground`) and the
 * same `px-4 py-2.5` cell rhythm by hand, and they have already drifted: five tables
 * have no row hover at all where every other one uses `hover:bg-secondary/40`.
 *
 * `Table` renders its own horizontal scroller. That is not cosmetic. The screenshot
 * review table is wrapped in `overflow-hidden` with fixed `w-40` and `w-72` columns, so
 * on a phone its Captures column is clipped and permanently unreachable — content that
 * exists and cannot be read. A table that is wider than its container must scroll, and
 * making that the default of the component is the only way it stays true. Put the
 * border and the radius on `containerClassName`; put any `min-w-[…]` on `className`.
 *
 * `docs/design.md` asks for dense tables, thin borders and subtle hover, which is what
 * these defaults are.
 */

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** Classes for the scroll container — border, radius and background belong here. */
  containerClassName?: string;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, containerClassName, ...props }, ref) => (
    /*
     * `max-h` is what makes `TableHead`'s `sticky top-0` actually stick.
     *
     * Measured, after shipping it broken: the header moved 96px for 96px of scroll —
     * exactly 1:1, so it was not sticking at all, even though `getComputedStyle`
     * reported `position: sticky`. Setting the property is not the same as it
     * engaging, and checking the property was the mistake.
     *
     * The cause is a CSS rule with no way around it: `overflow-x: auto` forces
     * `overflow-y` to `auto` as well, which makes THIS element the scrollport a
     * sticky child resolves against. With no height limit the element never scrolls
     * vertically, so `top: 0` has nothing to stick to and the page scrolls the whole
     * table away instead. A header cannot both stick to the viewport and live inside
     * a horizontally-scrolling box; one of the two has to give.
     *
     * So the box gets a height and becomes the scrollport it was already pretending
     * to be. A table shorter than the limit is completely unaffected — no inner
     * scrollbar, no visual change — and a long roster scrolls under its own headings,
     * which is the behaviour the dense-table direction wanted in the first place.
     */
    <div
      className={cn("relative max-h-[70vh] w-full overflow-auto", containerClassName)}
    >
      <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t bg-secondary/40 font-medium [&>tr]:last:border-b-0", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        // A softer rule than the container border. At full strength every row reads as
        // a boundary and a twenty-row table becomes a grid; the point of a hairline is
        // that the eye crosses it without stopping.
        "border-b border-border/60 transition-colors hover:bg-secondary/40 data-[state=selected]:bg-secondary",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /**
   * Current sort of this column. Sets `aria-sort`, which is how a screen reader
   * announces a sorted table — none of the six hand-rolled sort headers set it.
   */
  sortDirection?: "asc" | "desc" | null;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, sortDirection, ...props }, ref) => (
    <th
      ref={ref}
      aria-sort={
        sortDirection === undefined
          ? undefined
          : sortDirection === "asc"
            ? "ascending"
            : sortDirection === "desc"
              ? "descending"
              : "none"
      }
      className={cn(
        // Sticky, because these tables scroll. A roster of twenty people puts the
        // column names off screen exactly when a reader needs to know which column
        // they are looking at; the header has to survive its own table.
        // `bg-card` is not decoration here — without an opaque ground the rows scroll
        // *through* the header.
        "sticky top-0 z-10 h-9 whitespace-nowrap bg-card px-4 text-left align-middle",
        "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground",
        "[&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      // A floor rather than fixed padding: a single-line cell lands at the dense end
      // of the range the research puts Linear at, while a two-line cell (a name over
      // an email) still gets room instead of being crushed to fit.
      className={cn("h-[38px] px-4 py-2 align-middle", "[&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  ),
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-3 text-xs text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export interface TableSortButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** `null` when the table is sorted by some other column. */
  direction?: "asc" | "desc" | null;
}

/**
 * The sortable column header, written out six separate times across the people,
 * devices, apps, websites and both report tables.
 *
 * It sits inside a `<TableHead sortDirection={…}>`, which carries the `aria-sort`; the
 * button itself only needs a visible arrow and a focus ring. The neutral state shows a
 * dimmed double chevron rather than nothing, so a column that *can* be sorted is
 * discoverable before it is clicked.
 */
const TableSortButton = React.forwardRef<HTMLButtonElement, TableSortButtonProps>(
  ({ className, direction = null, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5",
        "text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors",
        direction ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {children}
      {direction === "asc" ? (
        <ArrowUp className="h-3 w-3 shrink-0" aria-hidden />
      ) : direction === "desc" ? (
        <ArrowDown className="h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden />
      )}
    </button>
  ),
);
TableSortButton.displayName = "TableSortButton";

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TableSortButton,
};
