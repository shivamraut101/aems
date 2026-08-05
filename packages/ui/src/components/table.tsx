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
    <div className={cn("relative w-full overflow-x-auto", containerClassName)}>
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
        "border-b transition-colors hover:bg-secondary/40 data-[state=selected]:bg-secondary",
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
        "h-9 whitespace-nowrap px-4 text-left align-middle",
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
      className={cn("px-4 py-2.5 align-middle", "[&:has([role=checkbox])]:pr-0", className)}
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
