"use client";

import { Sparkles } from "lucide-react";

export interface InsightBreakdown {
  label: string;
  percentage: number;
}

export interface AiInsightProps {
  summary: string;
  breakdown?: InsightBreakdown[];
  observation?: string | null;
  recommendation?: string | null;
  loading?: boolean;
}

/**
 * AI insight panel.
 *
 * Indigo is reserved for this surface across the whole product, so model-generated
 * text is distinguishable from recorded fact without needing a disclaimer on every
 * sentence. It is the one place in the dashboard allowed a tinted background.
 */
export function AiInsight({
  summary,
  breakdown,
  observation,
  recommendation,
  loading,
}: AiInsightProps) {
  return (
    <section
      aria-labelledby="ai-insight-heading"
      className="rounded-lg border border-accent/25 bg-accent/[0.04] p-5"
    >
      <h2
        id="ai-insight-heading"
        className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent"
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        AI workforce insight
      </h2>

      {loading ? (
        <div className="mt-3 space-y-2" aria-live="polite">
          <span className="block h-4 w-full animate-pulse rounded bg-muted" />
          <span className="block h-4 w-3/4 animate-pulse rounded bg-muted" />
        </div>
      ) : (
        <>
          <p className="mt-3 text-[15px] leading-relaxed">{summary}</p>

          {breakdown?.length ? (
            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
              {breakdown.map((item) => (
                <div key={item.label}>
                  <dt className="text-xs text-muted-foreground">{item.label}</dt>
                  <dd className="tabular text-lg font-semibold">{item.percentage}%</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {observation ? (
            <p className="mt-4 border-l-2 border-accent/40 pl-3 text-sm text-muted-foreground">
              {observation}
            </p>
          ) : null}

          {recommendation ? (
            <p className="mt-2 border-l-2 border-accent/40 pl-3 text-sm text-muted-foreground">
              {recommendation}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
