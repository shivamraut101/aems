"use client";

import { Badge } from "@aems/ui";
import Link from "next/link";

import type { Verdict } from "@/lib/verdict";
import { verdictAllClear } from "@/lib/verdict";

import { SkeletonBar } from "./states/skeletons";

/**
 * What the Overview says before it shows anything.
 *
 * One sentence a manager can act on — how many people are working, and the one person
 * worth opening — with the figures demoted underneath to support it rather than to be
 * decoded. The rule that picks the person lives in `lib/verdict.ts` and is tested
 * there; this file only draws the answer.
 *
 * The figures are still here, deliberately. Leading with a conclusion is not the same
 * as hiding the evidence, and a manager who disagrees with the sentence needs the
 * numbers in the same glance to check it.
 */
export function VerdictBlock({
  verdict,
  figures,
  loading,
}: {
  verdict: Verdict | null;
  figures: { label: string; value: string }[];
  loading?: boolean;
}) {
  return (
    <section
      aria-label="Today at a glance"
      className="rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6"
    >
      {loading || verdict === null ? (
        // Same block, same height, so the real reading lands where the placeholder was.
        <>
          <SkeletonBar className="h-8 w-56 max-w-full" />
          <SkeletonBar className="mt-3 h-4 w-4/5 max-w-lg" />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="tabular text-2xl font-semibold tracking-[-0.025em] sm:text-[26px]">
              {verdict.working} of {verdict.total} working
            </h2>
            {verdict.attention ? (
              <Badge variant="warning" dot>
                1 needs a look
              </Badge>
            ) : verdictAllClear(verdict) ? (
              <Badge variant="success" dot>
                All clear
              </Badge>
            ) : null}
          </div>

          <p className="mt-2 max-w-[64ch] text-sm text-muted-foreground">
            {verdict.attention ? (
              <>
                {/* The name is a link, because the next thing a reader wants is that
                    person's day — not a search for them. */}
                <Link
                  href={`/people/${verdict.attention.profileId}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {verdict.attention.name}
                </Link>{" "}
                {verdict.attention.reason}.
              </>
            ) : verdictAllClear(verdict) ? (
              "Every enrolled device is reporting."
            ) : (
              "Nothing has been recorded yet today."
            )}
          </p>
        </>
      )}

      <dl className="mt-5 flex flex-wrap gap-x-7 gap-y-3 border-t pt-4">
        {figures.map((figure) => (
          <div key={figure.label}>
            <dd className="tabular text-base font-semibold tracking-[-0.02em] sm:text-[17px]">
              {loading ? <SkeletonBar className="h-5 w-14" /> : figure.value}
            </dd>
            <dt className="text-[11px] text-muted-foreground">{figure.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}
