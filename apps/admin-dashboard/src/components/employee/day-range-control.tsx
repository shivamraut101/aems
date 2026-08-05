"use client";

import { cn } from "@aems/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { isoDate, resolveDay, type DayWindow } from "./day-window";
import { dayHref } from "./tabs";

const control = [
  "inline-flex h-9 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-sm",
  "transition-colors hover:bg-secondary",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-card",
].join(" ");

/**
 * Which day the page is showing, held in the URL.
 *
 * `router.replace` rather than `push`: a manager stepping back through a week should
 * not have to press Back seven times to leave the page. Every other query parameter
 * is preserved, so a tab that adds its own state to the URL keeps it when the day
 * changes.
 */
export function DayRangeControl({ day }: { day: DayWindow }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const goTo = useCallback(
    (date: string | null) => router.replace(dayHref(pathname, search.toString(), date), { scroll: false }),
    [pathname, router, search],
  );

  const today = isoDate(new Date());

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => goTo(day.previous)}
          className={cn(control, "px-2")}
          aria-label="Previous day"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => day.next && goTo(day.next)}
          disabled={day.next === null}
          className={cn(control, "px-2")}
          aria-label="Next day"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <label className="sr-only" htmlFor="employee-day">
        Day
      </label>
      <input
        id="employee-day"
        type="date"
        value={day.date}
        // No future days: there is nothing recorded there, and an empty tomorrow
        // looks like a broken agent rather than like a date that has not happened.
        max={today}
        onChange={(event) => {
          const next = resolveDay(event.target.value);
          goTo(next.date === today ? null : next.date);
        }}
        className={cn(control, "tabular px-2.5")}
      />

      <button
        type="button"
        onClick={() => goTo(null)}
        disabled={day.isToday}
        className={control}
      >
        Today
      </button>
    </div>
  );
}
