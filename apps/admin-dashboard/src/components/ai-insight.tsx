"use client";

import { Sparkles } from "lucide-react";

export interface InsightBreakdown {
  label: string;
  percentage: number;
}

/**
 * Something true about the panel that is not a summary.
 *
 * Distinct from `summary` on purpose. A summary is the model's sentence; a notice is
 * ours, about why there is no sentence — "no run has happened yet", "this period is
 * empty". Passing our copy through `summary` is exactly the defect this page had:
 * a developer note rendered in the model's voice, indistinguishable from output.
 */
export interface AiInsightNotice {
  title: string;
  body: string;
}

export interface AiInsightProps {
  summary: string;
  breakdown?: InsightBreakdown[];
  observation?: string | null;
  recommendation?: string | null;
  loading?: boolean;
  /** Replaces the summary when there is nothing written for this period. */
  notice?: AiInsightNotice | null;
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
  notice,
}: AiInsightProps) {
  return (
    <section
      aria-labelledby="ai-insight-heading"
      // The tint and the accent border are this panel's own; the radius and the lift
      // are the shared card treatment, so it sits at the same depth as the verdict
      // block above it rather than reading as a different kind of object.
      className="rounded-lg border border-accent/25 bg-accent/[0.04] p-5 shadow-[var(--shadow-sm)]"
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
      ) : notice ? (
        // Deliberately in the ordinary text colours, not the model's voice: this is
        // the product explaining itself, and it must not read as a generated finding.
        <div className="mt-3">
          <p className="text-sm font-medium">{notice.title}</p>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{notice.body}</p>
        </div>
      ) : (
        <>
          <p className="mt-3 text-[15px] leading-relaxed">{summary}</p>

          {breakdown?.length ? (
            /*
             * A split, drawn as a split.
             *
             * Three loose "62%" figures side by side are three numbers to compare in
             * your head; the bars make the proportion the first thing read and leave
             * the figures to confirm it. They are indigo because this *is* the model's
             * reading of how time divided, not a measured total — the same rule that
             * puts the whole panel in indigo applies inside it.
             */
            <dl className="mt-4 space-y-2">
              {breakdown.map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <dt
                    className="w-24 shrink-0 truncate text-xs text-muted-foreground sm:w-32"
                    title={item.label}
                  >
                    {item.label}
                  </dt>
                  {/* Clamped, because a model can return 118% and a bar cannot. */}
                  <div className="h-1.5 min-w-0 flex-1 rounded-full bg-accent/15" aria-hidden>
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.max(0, Math.min(100, item.percentage))}%` }}
                    />
                  </div>
                  <dd className="tabular w-10 shrink-0 text-right text-sm font-semibold">
                    {item.percentage}%
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {observation || recommendation ? (
            <div className="mt-4 space-y-3">
              {observation ? <Note label="Observation">{observation}</Note> : null}
              {recommendation ? <Note label="Recommendation">{recommendation}</Note> : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The model's two follow-on statements, told apart by name.
 *
 * They rendered as two identical grey paragraphs behind the same accent rule, so
 * nothing on screen said which was the reading of the week and which was the thing to
 * do about it — and a recommendation a manager mistakes for an observation is a
 * recommendation nobody acts on. `docs/design.md` labels both by name, which is also
 * the reason the worker keeps them as separate fields rather than one blob.
 */
function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-accent/40 pl-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent">{label}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
