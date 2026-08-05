"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@aems/ui";
import { ChevronLeft, ChevronRight, ImageOff, Monitor } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { employeeQuery } from "@/components/employee/employee-queries";
import { displayName } from "@/components/employee/identity";
import { describeError, useApiQuery } from "@/lib/api";
import {
  buildReviewRows,
  dayWindow,
  flattenCaptures,
  localDateString,
  noteImageFailure,
  shiftDate,
  stepCapture,
  useScreenshotBlocks,
  useTimelineSlots,
  type FlatCapture,
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
 */
export function ScreenshotReview({
  profileId,
  date: initialDate,
  today: initialToday,
  dateWasExplicit = false,
}: {
  profileId: string;
  /** `YYYY-MM-DD`, resolved on the server so the first paint has a window. */
  date: string;
  /** The server's calendar day, corrected to the viewer's after hydration. */
  today: string;
  /** True when the day came from the URL, so the browser must not second-guess it. */
  dateWasExplicit?: boolean;
}) {
  const router = useRouter();

  // The name for the lightbox caption, read from the entry the route layout already
  // prefetched. This page used to fetch `/api/employees/:id` a second time, server
  // side, purely for one string — the same record the header above it was already
  // holding. Reading the cache also means the caption and the header can never
  // disagree about who is being reviewed.
  const person = useApiQuery(employeeQuery(profileId), { enabled: Boolean(profileId) });
  const personName = person.data ? displayName(person.data) : null;
  const [date, setDate] = useState(initialDate);
  const [today, setToday] = useState(initialToday);

  // Both dates start as the server's, because deriving them from the browser clock
  // during render is a hydration mismatch. The correction runs after hydration, so a
  // viewer whose calendar day differs from the API host's does not open on an empty
  // day — and does not see the "next day" arrow enabled on their own today.
  useEffect(() => {
    const local = localDateString();
    if (local === initialToday) return;
    setToday(local);
    if (!dateWasExplicit) setDate(local);
  }, [dateWasExplicit, initialToday]);

  const { from, to } = useMemo(() => dayWindow(date), [date]);

  const blocks = useScreenshotBlocks(profileId, from, to);
  const timeline = useTimelineSlots(profileId, from, to);

  const rows = useMemo(
    () => buildReviewRows({ blocks: blocks.data?.blocks ?? [], slots: timeline.data?.slots ?? [] }),
    [blocks.data, timeline.data],
  );
  const captures = useMemo(() => flattenCaptures(rows), [rows]);

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

  function goToDate(next: string) {
    setDate(next);
    // The window is part of what the URL identifies, so a link to a day is a link to
    // that day rather than to "whenever you happen to open it".
    router.replace(`?date=${next}`, { scroll: false });
  }

  const isToday = date >= today;
  const captureCount = blocks.data?.screenshotCount ?? 0;

  return (
    <section aria-labelledby="screenshot-review-heading">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="screenshot-review-heading" className="text-base font-semibold tracking-tight">
            Screenshots
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {blocks.isSuccess
              ? captureCount === 0
                ? "No captures recorded for this day."
                : `${captureCount} capture${captureCount === 1 ? "" : "s"} across ${rows.length} ten-minute blocks.`
              : "Captures are grouped into ten-minute blocks, beside the activity they belong to."}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <DayStepButton
            label="Previous day"
            onClick={() => goToDate(shiftDate(date, -1))}
            icon={ChevronLeft}
          />
          <input
            type="date"
            value={date}
            max={today}
            onChange={(event) => event.target.value && goToDate(event.target.value)}
            aria-label="Day to review"
            className="h-9 rounded-md border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <DayStepButton
            label="Next day"
            onClick={() => goToDate(shiftDate(date, 1))}
            icon={ChevronRight}
            disabled={isToday}
          />
        </div>
      </header>

      {blocks.isError ? (
        <Panel tone="error">
          <p className="text-sm font-medium">Screenshots could not be loaded</p>
          <p className="mt-1 text-sm text-muted-foreground">{describeError(blocks.error)}</p>
        </Panel>
      ) : blocks.isPending ? (
        <SkeletonTable />
      ) : rows.length === 0 || captureCount === 0 ? (
        <Panel>
          <p className="text-sm font-medium">No captures on this day</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {isToday
              ? "Captures appear here as the agent reports them, at the interval your company policy sets."
              : "Nothing was captured — the device may have been offline, clocked out, or on a declared break all day."}
          </p>
        </Panel>
      ) : (
        <>
          {blocks.data?.truncated ? (
            <p className="mb-3 rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 px-3 py-2 text-sm">
              Showing the first {captureCount} captures of this day. Narrow the range to see the rest.
            </p>
          ) : null}

          {timeline.isError ? (
            <p className="mb-3 text-sm text-muted-foreground">
              Activity for these blocks is unavailable — {describeError(timeline.error)}
            </p>
          ) : null}

          <ReviewTable
            rows={rows}
            failures={failures}
            onImageError={handleImageError}
            onOpen={setLightbox}
          />
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

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function ReviewTable({
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
    // Two boxes, and the inner one is the fix. The outer `overflow-hidden` exists only
    // to clip the table's corners to the panel's radius — on its own it *cropped* this
    // table, because three columns of block time, activity and capture tiles do not
    // fit in 375px and clipping is not scrolling. The inner scroller gives the table a
    // width of its own; the page body keeps its.
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">
            Screen captures grouped into ten-minute blocks, with the activity recorded in each block.
          </caption>
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              {/* Proportions, not pixels: the two narrow columns take a share of
                  whatever width the scroller settles on rather than pinning 448px of
                  it and leaving the captures whatever is left. */}
              <th scope="col" className="w-[22%] px-4 py-2 font-medium">
                Block
              </th>
              <th scope="col" className="w-[34%] px-4 py-2 font-medium">
                Activity
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Captures
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const start = cursor;
              cursor += row.captures.length;

              return (
                <tr key={row.key} className="border-b align-top last:border-0">
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <span className="tabular text-sm font-medium">{row.timeLabel}</span>
                    {row.monitorCount > 1 ? (
                      <span
                        className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
                        title={`${row.monitorCount} displays captured`}
                      >
                        <Monitor className="h-3.5 w-3.5" aria-hidden />
                        {row.monitorCount} displays
                      </span>
                    ) : null}
                  </th>

                  <td className="px-4 py-3">
                    <p className="truncate font-medium">{row.activity.headline}</p>
                    {/* Words, never a percentage — docs/design.md: a bare score beside
                        a person's name is the framing this product refuses. */}
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.activity.split}</p>
                    <ActivityBar bar={row.activity.bar} />
                  </td>

                  <td className="px-4 py-3">
                    {row.hasCapture ? (
                      // Wraps rather than scrolling. A strip with its own horizontal
                      // scrollbar inside a table that now has one too is two nested
                      // scroll gestures on the same axis, and on a phone neither is
                      // discoverable. Height is the axis this screen can spare.
                      <div className="flex flex-wrap gap-2 pb-1">
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
      <span style={{ width: `${bar.active * 100}%` }} className="bg-[hsl(var(--success))]" />
      <span style={{ width: `${bar.idle * 100}%` }} className="bg-[hsl(var(--warning))]" />
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

function DayStepButton({
  label,
  onClick,
  icon: Icon,
  disabled,
}: {
  label: string;
  onClick: () => void;
  icon: typeof ChevronLeft;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-md border bg-card hover:bg-secondary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

function Panel({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-4 py-10 text-center",
        tone === "error" && "border-destructive/30 bg-destructive/5",
      )}
    >
      {children}
    </div>
  );
}

/**
 * The shape of the table before it has one.
 *
 * Sized in fractions rather than in the pixels the real columns happen to occupy: the
 * old version laid out 32 + 48 + 28 + 28 rem of fixed bars inside an `overflow-hidden`
 * box, so on a phone the loading state was itself cropped — the first thing a reader
 * saw was already broken.
 */
function SkeletonTable() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
          <span className="h-4 w-16 shrink-0 animate-pulse rounded bg-muted sm:w-32" />
          <span className="h-4 min-w-0 flex-1 animate-pulse rounded bg-muted" />
          <span className="h-[4.5rem] w-28 shrink-0 animate-pulse rounded-md bg-muted" />
          <span className="hidden h-[4.5rem] w-28 shrink-0 animate-pulse rounded-md bg-muted sm:block" />
        </div>
      ))}
      <span className="sr-only">Loading screen captures</span>
    </div>
  );
}
