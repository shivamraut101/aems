"use client";

import { cn } from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarDays, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

export function RangePicker({ className }: { className?: string }) {
  const { selection, setSelection } = useRangeSelection();
  const setDefaultRange = useFilters((state) => state.setDefaultRange);

  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape without this leaves focus on a node that has just been unmounted,
      // which drops a keyboard user back to the top of the document.
      triggerRef.current?.focus();
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function choosePreset(preset: DateRangePreset) {
    setSelection({ kind: "preset", preset });
    // The last preset chosen becomes the default the next screen opens with.
    setDefaultRange(preset);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function step(delta: -1 | 1) {
    // Read the clock at click time rather than from render state: correct even if
    // the tab has been open across midnight.
    setSelection(shiftRange(selection, delta, new Date()));
  }

  return (
    <div className={cn("relative flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="Previous period"
        className={arrowClass}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="flex h-9 min-w-[9.5rem] items-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium shadow-sm transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
      </button>

      <button
        type="button"
        onClick={() => step(1)}
        disabled={!forward}
        aria-label="Next period"
        className={arrowClass}
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Choose a date range"
          className="absolute right-0 top-11 z-20 w-[19rem] rounded-lg border bg-popover p-3 shadow-lg"
        >
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
                      "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
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
              triggerRef.current?.focus();
            }}
          />
        </div>
      ) : null}
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
      <div className="mt-1.5 flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={fromId} className="block text-xs text-muted-foreground">
            From
          </label>
          <input id={fromId} type="date" max={today || undefined} className={dateFieldClass} {...register("from")} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={toId} className="block text-xs text-muted-foreground">
            To
          </label>
          <input id={toId} type="date" max={today || undefined} className={dateFieldClass} {...register("to")} />
        </div>
        <button
          type="submit"
          className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Apply
        </button>
      </div>
      {errors.from ?? errors.to ? (
        <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">
          {errors.to?.message ?? errors.from?.message}
        </p>
      ) : null}
    </form>
  );
}

const dateFieldClass =
  "h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** Placeholder for the Suspense boundary `useSearchParams` requires. */
export function RangePickerFallback() {
  return <span className="block h-9 w-[15rem] rounded-md border border-input bg-card" />;
}
