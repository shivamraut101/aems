"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  TableSortButton,
  cn,
} from "@aems/ui";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useMemo } from "react";

import {
  cellOf,
  compareCells,
  renderCell,
  sharePercent,
  type CellValue,
  type ReportRow,
  type UsageColumn,
} from "@/lib/queries/usage";

/**
 * One section of a usage report, as a dense table.
 *
 * The Apps and Websites tabs carried the same hundred and thirty lines each, and the
 * only difference between the two copies was which column got the bold treatment — a
 * column that is always the first one, in both reports. Two copies of a table is how
 * one of them ends up with a sort arrow the other lost.
 *
 * It sits on the `@aems/ui` primitives rather than a hand-rolled `<table>`, which is
 * where the sticky header, the 38px row rhythm and the horizontal scroller come from.
 * A usage report is nine columns wide at its widest; it scrolls inside this container
 * and never pushes the page sideways.
 */
export function UsageTable({
  columns,
  rows,
  totals,
  caption,
}: {
  columns: UsageColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  caption: string;
}) {
  const columnDefs = useMemo<ColumnDef<ReportRow>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.label,
        accessorFn: (row: ReportRow) => cellOf(row, column.id),
        sortingFn: (a, b, id) =>
          compareCells(a.getValue<CellValue>(id), b.getValue<CellValue>(id), column.numeric),
        cell: ({ row }) =>
          column.id === "share" ? (
            <ShareCell
              value={cellOf(row.original, column.id)}
              text={renderCell(row.original, column)}
            />
          ) : (
            renderCell(row.original, column)
          ),
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const columnOf = (id: string) => columns.find((candidate) => candidate.id === id);
  // The subject of the report — the application or the domain — is always column one,
  // and it is the one cell in the row that carries full-strength ink.
  const labelId = columns[0]?.id;

  return (
    <Table containerClassName="rounded-lg border bg-card" className="min-w-[34rem]">
      <caption className="sr-only">{caption}</caption>

      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id} className="hover:bg-transparent">
            {group.headers.map((header) => {
              const column = columnOf(header.column.id);
              const direction = header.column.getIsSorted();

              return (
                <TableHead
                  key={header.id}
                  scope="col"
                  sortDirection={direction === false ? null : direction}
                  className={cn(column?.align === "right" && "text-right")}
                >
                  <TableSortButton
                    direction={direction === false ? null : direction}
                    onClick={header.column.getToggleSortingHandler()}
                    // The arrow stays beside the number rather than at the far end of
                    // a right-aligned column, where it reads as belonging to nothing.
                    className={cn(column?.align === "right" && "flex-row-reverse")}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableSortButton>
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>

      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => {
              const column = columnOf(cell.column.id);

              return (
                <TableCell
                  key={cell.id}
                  className={cn(
                    column?.align === "right" ? "tabular text-right" : "text-muted-foreground",
                    cell.column.id === labelId && "font-medium text-foreground",
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>

      {totals ? (
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            {columns.map((column, index) => (
              <TableCell
                key={column.id}
                className={cn(column.align === "right" && "tabular text-right")}
              >
                {index === 0 ? "Total" : renderCell(totals, column)}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}

/**
 * The row the day mostly went into.
 *
 * The API returns these busiest-first and both tabs say so, but the sentence above the
 * table states a fact about somebody's working day — it must not quietly depend on an
 * ordering the caller cannot see for itself.
 */
export function busiestRow(rows: readonly ReportRow[]): ReportRow | null {
  return rows.reduce<ReportRow | null>(
    (best, row) =>
      Number(cellOf(row, "duration") ?? 0) > Number(cellOf(best, "duration") ?? 0) ? row : best,
    null,
  );
}

/**
 * The share, as a number and as a length.
 *
 * Navy at low opacity rather than a status colour: a share is neither a success nor a
 * warning. Never indigo — `--accent` is reserved for AI surfaces. `--primary` inverts
 * between the themes (navy on white, near-white on navy), so the same class is a dark
 * bar on a light track in one and the reverse in the other.
 *
 * Hidden from assistive technology because the percentage beside it is the same fact.
 */
function ShareCell({ value, text }: { value: CellValue; text: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-primary/40"
          style={{ width: `${sharePercent(value)}%` }}
        />
      </span>
      <span className="tabular w-10 text-right">{text}</span>
    </span>
  );
}
