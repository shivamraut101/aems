"use client";

import { cn } from "@aems/ui";

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Written out rather than interpolated: Tailwind reads this file as text, so a
 * `lg:grid-cols-${n}` would generate no class at all and the row would silently
 * collapse to one column on wide screens.
 */
const WIDE_COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

/**
 * The only place cards are used.
 *
 * docs/design.md is explicit that not every metric becomes a card — KPIs get cards,
 * operations get tables, history gets the timeline, trends get charts.
 */
export function KpiRow({ items, loading }: { items: Kpi[]; loading?: boolean }) {
  // The block's background IS the hairline, so an unfilled cell in the last row
  // shows as a bar of border colour. An odd tile spans both mobile columns instead.
  const spanLast = items.length % 2 === 1;

  return (
    // One bordered block with hairline dividers rather than four floating cards.
    // Stripe and Datadog both read as instruments this way: the figures line up on a
    // shared baseline and the eye compares them, where separated cards ask it to
    // travel. `gap-px` over `bg-border` draws the hairlines — a real 1px at any zoom,
    // which a border on each cell cannot do without doubling where two meet.
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        WIDE_COLUMNS[items.length] ?? "lg:grid-cols-4",
      )}
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "bg-card px-5 py-4",
            spanLast && index === items.length - 1 && "col-span-2 lg:col-span-1",
          )}
        >
          <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {item.label}
          </dt>
          <dd
            className={cn(
              // The figure is the content; everything around it is a caption. Optical
              // tightening at this size stops the digits reading as loose.
              "tabular mt-2 text-[27px] font-semibold leading-[1.1] tracking-[-0.02em]",
              loading && "animate-pulse text-muted-foreground/40",
            )}
          >
            {loading ? "—" : item.value}
          </dd>
          {item.hint ? <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}
