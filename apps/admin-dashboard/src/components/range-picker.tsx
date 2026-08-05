"use client";

import { Popover, PopoverContent, PopoverTrigger, cn } from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarDays, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  RANGE_PRESETS,
  applyRangeToQuery,
  canShiftForward,
  dayKey,
  parseRangeSelection,
  rangeLabel,
  resolveRange,
  shiftRange,
  useFilters,
  type DateRangePreset,
  type RangeSelection,
} from "@/store/filters";

/**
 * The range control, and the hook every ranged screen reads it through.
 *
 * The window lives in the query string, not in a store: a manager who finds
 * something odd in last Tuesday's numbers has to be able to send that exact view to
 * someone else, and Back has to return to the window they came from. Zustand keeps
 * only the *default* preset — a preference — so nothing about what the server knows
 * is mirrored into client state.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface RangeState {
  selection: RangeSelection;
  setSelection: (next: RangeSelection) => void;
  /** The `[from, to)` instants to send to the API. Quantised to local midnights. */
  from: string;
  to: string;
  /**
   * A stable string identifying this window — safe to drop straight into a query
   * key, where two objects that are equal but not identical would refetch forever.
   */
  rangeKey: string;
}

export function useRangeSelection(): RangeState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fallback = useFilters((state) => state.defaultRange);

  const search = searchParams.toString();

  const selection = useMemo(
    () =>
      parseRangeSelection(
        {
          range: searchParams.get("range"),
          from: searchParams.get("from"),
          to: searchParams.get("to"),
        },
        fallback,
      ),
    [searchParams, fallback],
  );

  const setSelection = useCallback(
    (next: RangeSelection) => {
      const query = applyRangeToQuery(search, next);
      // replace(), not push(): dragging a range around should not bury the page the
      // reader arrived from under twenty history entries.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  // `resolveRange` ends the window at the next local midnight rather than at `now`,
  // so this memo returns the same two strings all day and the query key holds.
  const { from, to } = useMemo(() => resolveRange(selection, new Date()), [selection]);

  return { selection, setSelection, from, to, rangeKey: `${from}/${to}` };
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function absoluteSchema(today: string) {
  return z
    .object({
      from: z.string().regex(DAY_PATTERN, "Pick a start date"),
      to: z.string().regex(DAY_PATTERN, "Pick an end date"),
    })
    .refine((values) => values.from <= values.to, {
      message: "The end date is before the start date",
      path: ["to"],
    })
    .refine((values) => values.to <= today, {
      // Not a validation nicety: a window ending in the future returns nothing and
      // reads as "this employee did no work", which is a lie about a person.
      message: "There is no data after today",
      path: ["to"],
    });
}

type AbsoluteValues = z.infer<ReturnType<typeof absoluteSchema>>;

/**
 * The window control: two steppers and a panel.
 *
 * The panel is a `Popover` from `packages/ui` rather than the hand-rolled `role="dialog"`
 * div this used to carry. That version owned four behaviours it had to keep correct by
 * itself — an Escape listener, outside-click detection through `panelRef.contains`, a
 * matching pair of `document.addEventListener` calls with cleanup, and focus returning
 * to the trigger — and it still missed the fifth: anchored `right-0` at a fixed 304px
 * with no collision handling, it ran off the edge of a narrow viewport. Radix's
 * `collisionPadding` and available-width variables are the reason to adopt the
 * primitive; the four it already had are the reason not to keep two copies.
 */
export function RangePicker({ className }: { className?: string }) {
  const { selection, setSelection } = useRangeSelection();
  const setDefaultRange = useFilters((state) => state.setDefaultRange);

  const [open, setOpen] = useState(false);

  /**
   * The clock is read after mount, never during render.
   *
   * A server render and a browser render can disagree about what "today" is when the
   * two machines sit in different timezones, and a disagreement inside rendered
   * output is a hydration error. Until this lands, the label falls back to the plain
   * date and the forward arrow stays disabled — both true statements.
   */
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const today = now ? dayKey(now) : "";
  const label = rangeLabel(selection, now ?? new Date(0));
  const forward = now ? canShiftForward(selection, now) : false;

  function choosePreset(preset: DateRangePreset) {
    setSelection({ kind: "preset", preset });
    // The last preset chosen becomes the default the next screen opens with.
    setDefaultRange(preset);
    // Radix returns focus to the trigger on close, so nothing here has to.
    setOpen(false);
  }

  function step(delta: -1 | 1) {
    // Read the clock at click time rather than from render state: correct even if
    // the tab has been open across midnight.
    setSelection(shiftRange(selection, delta, new Date()));
  }

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="Previous period"
        className={arrowClass}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-9 min-w-[8.5rem] max-w-full items-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium shadow-sm transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-w-[9.5rem]"
          >
            <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        </PopoverTrigger>

        <PopoverContent aria-label="Choose a date range" className="w-[19rem]">
          <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Quick ranges
          </p>
          <ul className="mt-1.5 flex flex-col">
            {RANGE_PRESETS.map((preset) => {
              const active = selection.kind === "preset" && selection.preset === preset;
              return (
                <li key={preset}>
                  <button
                    type="button"
                    onClick={() => choosePreset(preset)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-secondary font-medium"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    {rangeLabel({ kind: "preset", preset }, now ?? new Date(0))}
                    {active ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>

          <AbsoluteRangeForm
            today={today}
            selection={selection}
            onApply={(next) => {
              setSelection(next);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      <button
        type="button"
        onClick={() => step(1)}
        disabled={!forward}
        aria-label="Next period"
        className={arrowClass}
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

const arrowClass =
  "grid h-9 w-9 shrink-0 place-items-center rounded-md border border-input bg-card text-muted-foreground shadow-sm transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

function AbsoluteRangeForm({
  today,
  selection,
  onApply,
}: {
  today: string;
  selection: RangeSelection;
  onApply: (next: RangeSelection) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const schema = useMemo(() => absoluteSchema(today || "9999-12-31"), [today]);

  const defaults: AbsoluteValues =
    selection.kind === "absolute" ? { from: selection.from, to: selection.to } : { from: "", to: "" };

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AbsoluteValues>({ resolver: zodResolver(schema), defaultValues: defaults });

  return (
    <form
      onSubmit={handleSubmit((values) =>
        onApply({ kind: "absolute", from: values.from, to: values.to }),
      )}
      noValidate
      className="mt-3 border-t pt-3"
    >
      <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Absolute range
      </p>
      {/* Two fields on one row and the button beneath, rather than all three abreast.
          A `type="date"` control has a native picker button inside it and stops being
          operable below roughly 120px — three items across a popover that Radix shrinks
          to the available width on a 375px screen is exactly that. */}
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1">
          <label htmlFor={fromId} className="block text-xs text-muted-foreground">
            From
          </label>
          <input id={fromId} type="date" max={today || undefined} className={dateFieldClass} {...register("from")} />
        </div>
        <div className="min-w-0 space-y-1">
          <label htmlFor={toId} className="block text-xs text-muted-foreground">
            To
          </label>
          <input id={toId} type="date" max={today || undefined} className={dateFieldClass} {...register("to")} />
        </div>
      </div>
      {errors.from ?? errors.to ? (
        <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">
          {errors.to?.message ?? errors.from?.message}
        </p>
      ) : null}
      <button
        type="submit"
        className="mt-2 h-9 w-full rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        Apply
      </button>
    </form>
  );
}

const dateFieldClass =
  "h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/**
 * Placeholder for the Suspense boundary `useSearchParams` requires.
 *
 * Sized to the control it stands in for — two 36px steppers, the trigger and the two
 * 4px gaps — so the header does not jump sideways when the real picker mounts.
 * `max-w-full` because a fixed width is the one thing that makes a phone scroll.
 */
export function RangePickerFallback() {
  return <span className="block h-9 w-[14.5rem] max-w-full rounded-md border border-input bg-card" />;
}
