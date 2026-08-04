"use client";

import { cn } from "@aems/ui";

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
}

/**
 * The only place cards are used.
 *
 * docs/design.md is explicit that not every metric becomes a card — KPIs get cards,
 * operations get tables, history gets the timeline, trends get charts.
 */
export function KpiRow({ items, loading }: { items: Kpi[]; loading?: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-card px-4 py-3.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd
            className={cn(
              "tabular mt-1.5 text-2xl font-semibold tracking-tight",
              loading && "animate-pulse text-muted-foreground/40",
            )}
          >
            {loading ? "—" : item.value}
          </dd>
          {item.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{item.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}
