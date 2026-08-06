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
    // One row that stays one row. At 390px these four controls are the whole width, so
    // below `sm` the control takes the line for itself and the date field absorbs
    // whatever the three fixed-width buttons leave — where wrapping would have put a
    // lone "Today" on a second line looking like it belonged to something else.
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => goTo(day.previous)}
          // Square rather than padding-wide: these are the two controls a thumb aims
          // at repeatedly, and `px-2` made them 32px on a touch screen.
          className={cn(control, "w-9 justify-center px-0")}
          aria-label="Previous day"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => day.next && goTo(day.next)}
          disabled={day.next === null}
          className={cn(control, "w-9 justify-center px-0")}
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
        // `min-w-0` is the load-bearing part. A native date field reports an intrinsic
        // width of its widest rendering, which on a phone is wider than the room left
        // beside three buttons — without this it refuses to shrink and pushes the
        // whole header sideways instead.
        className={cn(control, "tabular min-w-0 flex-1 px-2.5 sm:flex-none")}
      />

      <button
        type="button"
        onClick={() => goTo(null)}
        disabled={day.isToday}
        className={cn(control, "shrink-0")}
      >
        Today
      </button>
    </div>
  );
}
