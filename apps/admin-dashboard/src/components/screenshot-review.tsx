"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@aems/ui";
import { AlertTriangle, ChevronLeft, ChevronRight, ImageOff, Monitor } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { employeeQuery } from "@/components/employee/employee-queries";
import { displayName } from "@/components/employee/identity";
import { dayHref } from "@/components/employee/tabs";
import { useDayWindow } from "@/components/employee/use-day-window";
import { EmptyState, ErrorState, StaleNotice } from "@/components/states";
import { describeError, useApiQuery } from "@/lib/api";
import {
  BLOCK_STATE_LABELS,
  blockStateCounts,
  buildReviewRows,
  dayWindow,
  filterRowsByState,
  flattenCaptures,
  noteImageFailure,
  stepCapture,
  useScreenshotBlocks,
  useTimelineSlots,
  type FlatCapture,
  type BlockState,
  type ImageFailures,
  type ReviewCapture,
  type ReviewRow,
} from "@/lib/queries/screenshots";

/**
 * Screenshot review — one row per ten-minute block, each paired with the activity
 * that produced it.
 *
 * docs/design.md forbids a plain gallery, and the reason is legible the moment you
 * see both: a wall of thumbnails asks "what were they doing?" and answers nothing,
 * while a block that reads "09:20 – 09:30 · Code · Active 7m 30s · Idle 2m 30s"
 * carries its own explanation. Evidence always arrives with its context.
 *
 * Blocks with nothing in them are rendered, not skipped. "Nothing was captured
 * between 11:20 and 11:30" is a fact about the day, and a screen that collapses gaps
 * cannot show one.
 *
 * **The day comes from `useDayWindow`, like every other tab on this page.** It used to
 * be local state seeded by a server prop, which made this the one tab where the day
 * control in the employee header did nothing: that control writes `?date=` and this
 * component never read it back, so the header said one day and the captures showed
 * another. Reading the URL deletes the duplicate stepper that used to sit here, the
 * hydration-correction effect underneath it, and the disagreement.
 */
export function ScreenshotReview({ profileId }: { profileId: string }) {
  const pathname = usePathname();
  const search = useSearchParams();

  // The name for the lightbox caption, read from the entry the route layout already
  // prefetched. This page used to fetch `/api/employees/:id` a second time, server
  // side, purely for one string — the same record the header above it was already
  // holding. Reading the cache also means the caption and the header can never
  // disagree about who is being reviewed.
  const person = useApiQuery(employeeQuery(profileId), { enabled: Boolean(profileId) });
  const personName = person.data ? displayName(person.data) : null;

  const day = useDayWindow();
  const date = day?.date ?? null;

  // Memoised on the date string rather than recomputed per render, and that matters:
  // `dayWindow` closes a day in progress at the *current* ten-minute block, so an
  // unmemoised call would mint a fresh `to` — and a fresh query key — as the clock
  // rolled over, blanking the screen to its skeleton mid-review. Empty strings before
  // the day is known, which is what leaves both queries disabled for that first frame.
  const { from, to } = useMemo(
    () => (date ? dayWindow(date) : { from: "", to: "" }),
    [date],
  );

  const blocks = useScreenshotBlocks(profileId, from, to);
  const timeline = useTimelineSlots(profileId, from, to);

  const rows = useMemo(
    () => buildReviewRows({ blocks: blocks.data?.blocks ?? [], slots: timeline.data?.slots ?? [] }),
    [blocks.data, timeline.data],
  );
  const captures = useMemo(() => flattenCaptures(rows), [rows]);

  /**
   * Which kind of block the reviewer is looking for.
   *
   * Local state rather than a URL param: the day IS a URL on this page, because it is
   * worth linking to and coming back to. A transient "show me only the breaks" is not
   * — putting it in the address bar would mean a shared link silently hid most of the
   * evidence from whoever opened it.
   */
  const [stateFilter, setStateFilter] = useState<BlockState | "all">("all");

  const counts = useMemo(() => blockStateCounts(rows), [rows]);
  const visibleRows = useMemo(() => filterRowsByState(rows, stateFilter), [rows, stateFilter]);

  const [failures, setFailures] = useState<ImageFailures>({});
  const [lightbox, setLightbox] = useState<number>(-1);

  const refetchBlocks = blocks.refetch;
  const handleImageError = useCallback(
    (id: number) => {
      setFailures((current) => {
        const { state, action } = noteImageFailure(current, id);
        // A signed URL lives ten minutes; a page left open outlives it. Re-signing is
        // the fix, and the second failure is what stops that becoming a loop.
        if (action === "refetch") void refetchBlocks();
        return state;
      });
    },
    [refetchBlocks],
  );

  const isToday = day?.isToday ?? true;
  const captureCount = blocks.data?.screenshotCount ?? 0;
  // The denominator matters more than the count: "12 captures" says nothing without
  // how many blocks of the day went past uncaptured.
  const blocksWithCapture = rows.filter((row) => row.hasCapture).length;

  return (
    <section aria-labelledby="screenshot-review-heading">
      <header className="mb-5">
        <h2 id="screenshot-review-heading" className="text-base font-semibold tracking-tight">
          Screenshots
        </h2>
        {/* The lead is the coverage, not the total. A reviewer opens this tab to find
            out whether the day is evidenced, and "12 captures" cannot answer that on
            its own — "in 12 of 48 blocks" can. The day it counts is named because the
            control that changes it sits in the header, above this heading. */}
        <p className="mt-0.5 text-sm text-muted-foreground">
          {blocks.isSuccess
            ? captureCount === 0
              ? `No captures recorded${day ? ` on ${day.label}` : ""}.`
              : `${captureCount} capture${captureCount === 1 ? "" : "s"}${day ? ` on ${day.label}` : ""}, in ${blocksWithCapture} of ${rows.length} ten-minute blocks.`
            : "Captures are grouped into ten-minute blocks, beside the activity they belong to."}
        </p>
      </header>

      {blocks.isError ? (
        // A retry, not a dead end. Every other failure surface in the dashboard offers
        // one, and a signed-URL page is exactly the kind that recovers on a second ask.
        <ErrorState
          title="Screenshots could not be loaded"
          message={describeError(blocks.error)}
          onRetry={() => void blocks.refetch()}
        />
      ) : blocks.isPending ? (
        <ReviewSkeleton />
      ) : rows.length === 0 || captureCount === 0 ? (
        <EmptyState
          title="No captures on this day"
          body={
            isToday
              ? "Captures appear here as the agent reports them, at the interval your company policy sets."
              : "Nothing was captured — the device may have been offline, clocked out, or on a declared break all day."
          }
          action={
            // The commonest cause of an empty day is looking at the wrong one, and the
            // day control is up in the page header — far enough away that the way out
            // belongs here too. A link rather than a button, because the day is a URL
            // on this page and a link can be opened in a new tab.
            day ? (
              <Link
                href={dayHref(pathname, search.toString(), day.previous)}
                scroll={false}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Try the previous day
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          {blocks.data?.truncated ? (
            // `border-warning/40` rather than `border-[hsl(var(--warning))]/40`:
            // Tailwind cannot inject an alpha channel into an arbitrary `hsl(var(--x))`,
            // so the old form rendered a full-strength border and no tint at all.
            <p className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>
                Showing the first {captureCount} captures of this day. Narrow the range to
                see the rest.
              </span>
            </p>
          ) : null}

          {/* The captures still render when the timeline is unavailable — that is why
              they are two queries — so this is a stale notice over a working screen
              rather than an error that replaces it. */}
          {timeline.isError ? (
            <StaleNotice
              className="mb-3 rounded-md border border-warning/40"
              message={`Activity for these blocks is unavailable — ${describeError(timeline.error)}`}
              onRetry={() => void timeline.refetch()}
            />
          ) : null}

          <BlockFilter
            value={stateFilter}
            counts={counts}
            total={rows.length}
            onChange={setStateFilter}
          />

          {visibleRows.length === 0 ? (
            // A filter that empties the screen has to say so and offer the way back,
            // or it reads as a day with no captures rather than a choice the reviewer made.
            <EmptyState
              title={`No ${BLOCK_STATE_LABELS[stateFilter as BlockState].toLowerCase()} blocks on this day`}
              body="Every ten-minute block was spent on something else."
              action={
                <button
                  type="button"
                  onClick={() => setStateFilter("all")}
                  className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Show all blocks
                </button>
              }
            />
          ) : (
          <ReviewList
            rows={visibleRows}
            failures={failures}
            onImageError={handleImageError}
            onOpen={setLightbox}
          />
          )}
        </>
      )}

      {lightbox >= 0 && captures[lightbox] ? (
        <Lightbox
          captures={captures}
          index={lightbox}
          personName={personName ?? null}
          onStep={(delta) => setLightbox((current) => stepCapture(current, delta, captures.length))}
          onClose={() => setLightbox(-1)}
        />
      ) : null}
    </section>
  );
}

/**
 * Narrows the review to blocks that were mostly one thing.
 *
 * A segmented control rather than a dropdown: there are four options, they are always
 * the same four, and a reviewer scanning a day wants to move between them repeatedly.
 * A select would put two clicks between "show me the active blocks" and "show me the
 * breaks", on the screen where that comparison is the entire job.
 *
 * The counts are on the buttons, and an option with none is disabled. Selecting a
 * filter to discover there is nothing behind it is a dead end the control can simply
 * prevent — and seeing "On a break 0" is itself an answer about the day.
 *
 * Buckets are exclusive (see `dominantState`), so the four counts plus the blocks with
 * nothing recorded add up to the total. A reviewer can trust the arithmetic.
 */
function BlockFilter({
  value,
  counts,
  total,
  onChange,
}: {
  value: BlockState | "all";
  counts: Record<BlockState, number>;
  total: number;
  onChange: (next: BlockState | "all") => void;
}) {
  const options: { key: BlockState | "all"; label: string; count: number }[] = [
    { key: "all", label: "All blocks", count: total },
    ...(["active", "idle", "break", "offline"] as const).map((state) => ({
      key: state,
      label: BLOCK_STATE_LABELS[state],
      count: counts[state],
    })),
  ];

  return (
    <div
      role="group"
      aria-label="Filter blocks by activity"
      // Wraps rather than scrolls: five short chips fit two rows on a phone, and a
      // horizontally scrolled filter hides options a reviewer does not know to look for.
      className="mb-4 flex flex-wrap items-center gap-1.5"
    >
      {options.map((option) => {
        const selected = option.key === value;
        const empty = option.count === 0 && option.key !== "all";

        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={selected}
            disabled={empty}
            onClick={() => onChange(option.key)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-transparent bg-primary text-primary-foreground"
                : "bg-card hover:bg-secondary",
              empty && "cursor-not-allowed opacity-45 hover:bg-card",
            )}
          >
            {option.label}
            <span
              className={cn(
                "tabular text-[11px]",
                selected ? "text-primary-foreground/70" : "text-muted-foreground",
              )}
            >
              {option.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

/**
 * The day, one ten-minute block at a time.
 *
 * **Not a `<table>`, and not the shared `Table` primitive.** It was one, three columns
 * wide with a `min-w-[40rem]` and its own horizontal scroller, which meant that on a
 * phone the captures — the entire point of the screen — sat off the right edge behind
 * a sideways drag most people never find. A table cannot fold, and this content has to:
 * `docs/design.md` reserves tables for operations and this is history, closer to the
 * timeline than to the people roster.
 *
 * So it is a list of blocks that reflows instead. One column on a phone (block, then
 * activity, then captures, in reading order), block beside activity from `sm`, and all
 * three abreast from `lg` — the desktop reading the table used to give, without the
 * price the phone was paying for it.
 */
function ReviewList({
  rows,
  failures,
  onImageError,
  onOpen,
}: {
  rows: ReviewRow[];
  failures: ImageFailures;
  onImageError: (id: number) => void;
  onOpen: (index: number) => void;
}) {
  // Index within the flattened day, so a tile knows where the lightbox should open.
  let cursor = 0;

  return (
    <ul className="space-y-2.5" aria-label="Ten-minute blocks, each with the activity recorded in it">
      {rows.map((row) => {
        const start = cursor;
        cursor += row.captures.length;

        return (
          <li
            key={row.key}
            className="grid gap-x-4 gap-y-3 rounded-lg border bg-card p-3 shadow-[var(--shadow-sm)] sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:p-4 lg:grid-cols-[9.5rem_minmax(0,17rem)_minmax(0,1fr)]"
          >
            <div className="min-w-0">
              <h3 className="tabular text-sm font-medium">{row.timeLabel}</h3>
              {row.monitorCount > 1 ? (
                <p
                  className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
                  title={`${row.monitorCount} displays captured`}
                >
                  <Monitor className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {row.monitorCount} displays
                </p>
              ) : null}
            </div>

            <div className="min-w-0">
              {/* `title` carries what the truncation drops — an application name is
                  routinely longer than the column it lands in. */}
              <p className="truncate text-sm font-medium" title={row.activity.headline}>
                {row.activity.headline}
              </p>
              {/* Words, never a percentage — docs/design.md: a bare score beside
                  a person's name is the framing this product refuses. */}
              <p className="tabular mt-0.5 text-xs text-muted-foreground">{row.activity.split}</p>
              <ActivityBar bar={row.activity.bar} />
            </div>

            {/* Full width until there is room for a third column, so the captures get
                the whole line on the two narrower layouts rather than a sliver of one. */}
            <div className="min-w-0 sm:col-span-2 lg:col-span-1">
              {row.hasCapture ? (
                // Wraps rather than scrolling: height is the axis this screen can spare,
                // and a strip with its own sideways gesture is not discoverable on a phone.
                <div className="flex flex-wrap gap-2">
                  {row.captures.map((capture, offset) => (
                    <CaptureTile
                      key={capture.id}
                      capture={capture}
                      failed={(failures[capture.id] ?? 0) > 1}
                      onError={() => onImageError(capture.id)}
                      onOpen={() => onOpen(start + offset)}
                    />
                  ))}
                </div>
              ) : (
                <p className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                  No capture in this block
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The block's time split as a thin bar.
 *
 * Emerald active, amber idle, muted break, and offline as a hatch rather than a
 * colour — offline is the absence of a measurement, and giving it a solid fill would
 * make "we know nothing happened" look like "we measured nothing happening".
 */
function ActivityBar({ bar }: { bar: { active: number; idle: number; break: number; offline: number } }) {
  const total = bar.active + bar.idle + bar.break + bar.offline;
  if (total <= 0) return null;

  return (
    <span className="mt-2 flex h-1 w-full max-w-56 overflow-hidden rounded-full bg-muted" aria-hidden>
      {/* `bg-success` / `bg-warning` are real utilities now that status is in the
          token layer — an arbitrary `hsl(var(--x))` was how these were written before
          the preset carried them. */}
      <span style={{ width: `${bar.active * 100}%` }} className="bg-success" />
      <span style={{ width: `${bar.idle * 100}%` }} className="bg-warning" />
      <span style={{ width: `${bar.break * 100}%` }} className="bg-muted-foreground/50" />
      <span
        style={{
          width: `${bar.offline * 100}%`,
          backgroundImage:
            "repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.35) 0 2px, transparent 2px 4px)",
        }}
      />
    </span>
  );
}

function CaptureTile({
  capture,
  failed,
  onError,
  onOpen,
}: {
  capture: ReviewCapture;
  failed: boolean;
  onError: () => void;
  onOpen: () => void;
}) {
  const unavailable = capture.status === "unavailable" || failed;

  if (unavailable) {
    return (
      <span className="flex h-[4.5rem] w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center text-[11px] leading-tight text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5" aria-hidden />
        Capture
        <br aria-hidden />
        unavailable
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative shrink-0 rounded-md border bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open the capture from ${capture.timeLabel}`}
    >
      <img
        src={capture.thumbnailUrl ?? ""}
        alt=""
        loading="lazy"
        decoding="async"
        onError={onError}
        className="h-[4.5rem] w-28 rounded-[7px] object-cover transition-opacity group-hover:opacity-90"
      />
      <span className="tabular absolute inset-x-0 bottom-0 rounded-b-[7px] bg-primary/75 px-1 py-0.5 text-center text-[10px] font-medium text-primary-foreground">
        {capture.timeLabel}
        {capture.blurred ? " · blurred" : ""}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

/**
 * Full-resolution view of one capture.
 *
 * On the shared `@aems/ui` Dialog — Radix under Tailwind, which is what `docs/stack.md`
 * means by shadcn/ui. It replaced a hand-written modal that was the fifth independent
 * implementation of one in this app and reimplemented, by hand, the focus trap, the
 * Escape key, the scrim, the scroll lock and the focus restore. Four of those five had
 * already drifted apart; this one also asked every focusable child to carry a
 * `data-focusable` attribute so its Tab cycle could find them, which meant a control
 * added later was silently outside the trap.
 *
 * What is still written here is the part Radix does not own: Left and Right step
 * through the day. The reference implementations reviewed for this screen have prev
 * and next buttons and no keyboard handling at all, which makes reviewing forty
 * captures a mouse marathon. `composeEventHandlers` inside Radix runs its own key
 * handling first, so Escape still closes.
 */
function Lightbox({
  captures,
  index,
  personName,
  onStep,
  onClose,
}: {
  captures: FlatCapture[];
  index: number;
  personName: string | null;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const capture = captures[index];
  if (!capture) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        // `w-[calc(100vw-2rem)]` comes from the primitive, so this is already a
        // 343px-wide panel on a 375px phone; only the ceiling is raised here.
        className="max-w-5xl gap-0 p-0"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onStep(-1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onStep(1);
          }
        }}
      >
        <DialogHeader className="gap-0.5 border-b px-4 py-2.5">
          <DialogTitle className="tabular truncate text-sm">
            {capture.timeLabel}
            {personName ? ` · ${personName}` : ""}
          </DialogTitle>
          <DialogDescription className="tabular truncate text-xs">
            Block {capture.blockLabel} · capture {index + 1} of {captures.length}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 items-center justify-center bg-secondary/40 p-3">
          {capture.fullUrl ? (
            <img
              src={capture.fullUrl}
              alt={`Screen capture taken at ${capture.timeLabel}`}
              className="max-h-[65vh] w-auto max-w-full rounded-md object-contain"
            />
          ) : (
            <p className="px-6 py-16 text-center text-sm text-muted-foreground">
              This capture is unavailable — the stored image could not be read.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{capture.activity.headline}</p>
            <p className="truncate text-xs text-muted-foreground">{capture.activity.split}</p>
            {capture.activity.apps.length > 1 ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                Also in this block: {capture.activity.apps.slice(1).join(", ")}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onStep(-1)}
              disabled={index === 0}
              className="inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              Previous
            </button>
            <button
              type="button"
              onClick={() => onStep(1)}
              disabled={index === captures.length - 1}
              className="inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shell pieces
// ---------------------------------------------------------------------------

/**
 * The whole screen before its day is known.
 *
 * The page's Suspense fallback: `useDayWindow` reads `useSearchParams`, so the review
 * cannot render during prerender. Carries the heading's shape as well as the list's,
 * because a fallback that omits the header makes the real one shove the page down.
 */
export function ScreenshotReviewSkeleton() {
  return (
    <section aria-busy="true">
      <header className="mb-5">
        <span className="block h-5 w-28 animate-pulse rounded bg-muted" />
        <span className="mt-1.5 block h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
      </header>
      <ReviewSkeleton />
      <span className="sr-only">Loading screen captures</span>
    </section>
  );
}

/**
 * The shape of the list before it has one.
 *
 * Reflows on exactly the breakpoints the real blocks do, so the loading state and the
 * content it stands in for occupy the same space. The version before this laid out
 * 32 + 48 + 28 + 28 rem of fixed bars inside an `overflow-hidden` box, so on a phone
 * the loading state was itself cropped — the first thing a reader saw was broken.
 */
function ReviewSkeleton() {
  return (
    <div className="space-y-2.5" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="grid gap-x-4 gap-y-3 rounded-lg border bg-card p-3 shadow-[var(--shadow-sm)] sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:p-4 lg:grid-cols-[9.5rem_minmax(0,17rem)_minmax(0,1fr)]"
        >
          <span className="h-4 w-28 animate-pulse rounded bg-muted" />
          <div className="space-y-2">
            <span className="block h-4 w-2/3 animate-pulse rounded bg-muted" />
            <span className="block h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
            <span className="h-[4.5rem] w-28 animate-pulse rounded-md bg-muted" />
            <span className="hidden h-[4.5rem] w-28 animate-pulse rounded-md bg-muted sm:block" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading screen captures</span>
    </div>
  );
}
