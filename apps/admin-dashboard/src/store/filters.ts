"use client";

import { create } from "zustand";

/**
 * The view window, and the small amount of state that is genuinely client-only.
 *
 * Two rules shape this file:
 *
 *  1. **The URL is the source of truth for what is being looked at.** Range and
 *     filters live in the query string so a view is shareable and Back works.
 *     Zustand holds only preferences — a preferred default range, which columns a
 *     person hid — which no server ever knows about. Mirroring server data here is
 *     what CLAUDE.md forbids, and a range that only exists in memory is the same
 *     mistake one step earlier: it makes every screen implicitly "now".
 *  2. **Everything that computes a window is a pure function of `(selection, now)`.**
 *     `now` is injected rather than read inside, so the day-boundary arithmetic is
 *     testable in any timezone instead of only in the author's.
 */

export type DateRangePreset = "today" | "yesterday" | "7d" | "30d";

/** Preset order is the button order in the picker. */
export const RANGE_PRESETS: readonly DateRangePreset[] = ["today", "yesterday", "7d", "30d"];

const PRESET_LABEL: Record<DateRangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/**
 * A window, either named or spelled out.
 *
 * Absolute ends are calendar days (`YYYY-MM-DD`), inclusive of both, because that is
 * what a date input means and what a person means. Turning them into instants is
 * {@link resolveRange}'s job.
 */
export type RangeSelection =
  | { kind: "preset"; preset: DateRangePreset }
  | { kind: "absolute"; from: string; to: string };

export const DEFAULT_RANGE: RangeSelection = { kind: "preset", preset: "today" };

// ---------------------------------------------------------------------------
// Day keys
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local calendar day of an instant, as `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `YYYY-MM-DD` to local midnight, or null if it is not a real date.
 *
 * Deliberately not `new Date(value)`: that parses a bare date string as **UTC**, so
 * in any timezone behind UTC "2026-08-05" becomes the evening of the 4th and every
 * day boundary lands an hour or twelve out. It also cheerfully accepts "2026-02-31"
 * and rolls it into March, which is why the round-trip check below exists.
 */
export function parseDayKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return dayKey(date) === value ? date : null;
}

function addDays(day: string, delta: number): string {
  const date = parseDayKey(day);
  if (!date) return day;
  // Midday before adding, so a DST transition cannot push the result onto the
  // neighbouring day.
  date.setHours(12, 0, 0, 0);
  return dayKey(new Date(date.getTime() + delta * DAY_MS));
}

function daysBetween(from: string, to: string): number {
  const start = parseDayKey(from);
  const end = parseDayKey(to);
  if (!start || !end) return 0;
  start.setHours(12, 0, 0, 0);
  end.setHours(12, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function formatDay(day: string, withYear: boolean): string {
  const date = parseDayKey(day);
  if (!date) return day;
  const month = MONTHS[date.getMonth()] ?? "";
  return withYear
    ? `${date.getDate()} ${month} ${date.getFullYear()}`
    : `${date.getDate()} ${month}`;
}

// ---------------------------------------------------------------------------
// Selection → days → instants
// ---------------------------------------------------------------------------

/** The inclusive first and last calendar day a selection covers. */
export function selectionDays(
  selection: RangeSelection | DateRangePreset,
  now: Date = new Date(),
): { start: string; end: string } {
  const resolved = typeof selection === "string" ? presetSelection(selection) : selection;
  const today = dayKey(now);

  if (resolved.kind === "absolute") {
    return { start: resolved.from, end: resolved.to };
  }

  switch (resolved.preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { start: day, end: day };
    }
    // "Last 7 days" includes today, so the window is today minus six — an employee
    // asked for a week of work, not a week plus the day they are standing in.
    case "7d":
      return { start: addDays(today, -6), end: today };
    case "30d":
      return { start: addDays(today, -29), end: today };
  }
}

function presetSelection(preset: DateRangePreset): RangeSelection {
  return { kind: "preset", preset };
}

/**
 * The ISO window the API expects: `[from, to)`, both local midnights.
 *
 * The end is the midnight *after* the last day rather than `now`, which matters more
 * than it looks: a `to` of `new Date()` changes on every render, so it changes the
 * TanStack Query key on every render, and the screen refetches forever. Quantising
 * to the day boundary makes today's window cacheable for the whole of today.
 */
export function resolveRange(
  selection: RangeSelection | DateRangePreset,
  now: Date = new Date(),
): { from: string; to: string } {
  const { start, end } = selectionDays(selection, now);
  const startDate = parseDayKey(start) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endDate = parseDayKey(addDays(end, 1)) ?? startDate;

  return { from: startDate.toISOString(), to: endDate.toISOString() };
}

// ---------------------------------------------------------------------------
// URL round trip
// ---------------------------------------------------------------------------

export interface RangeQuery {
  range?: string | null | undefined;
  from?: string | null | undefined;
  to?: string | null | undefined;
}

function isPreset(value: string): value is DateRangePreset {
  return (RANGE_PRESETS as readonly string[]).includes(value);
}

/**
 * Reads a selection out of query parameters, falling back rather than throwing.
 *
 * A query string is user input — hand-edited, truncated by a chat client, left over
 * from an older release. Anything unrecognised resolves to the default, because a
 * screen showing the default window is right and a screen showing an error because
 * someone mangled a link is not.
 */
export function parseRangeSelection(
  query: RangeQuery,
  fallback: DateRangePreset = "today",
): RangeSelection {
  const range = query.range?.trim() ?? "";
  const from = query.from?.trim() ?? "";
  const to = query.to?.trim() ?? "";

  if (range && isPreset(range)) return presetSelection(range);

  if (from && to) {
    const start = parseDayKey(from);
    const end = parseDayKey(to);
    if (start && end) {
      // A backwards window resolves to a negative range that every endpoint rejects
      // with `invalid_range`; ordering it is what the person meant.
      return daysBetween(from, to) < 0
        ? { kind: "absolute", from: to, to: from }
        : { kind: "absolute", from, to };
    }
  }

  return presetSelection(fallback);
}

/** The parameters that express a selection. Inverse of {@link parseRangeSelection}. */
export function rangeSearchParams(selection: RangeSelection): Record<string, string> {
  if (selection.kind === "preset") return { range: selection.preset };
  return { range: "custom", from: selection.from, to: selection.to };
}

/**
 * Writes parameters into an existing query string, leaving every other one be.
 *
 * The other parameters are the point: on a detail screen the query also carries the
 * person being viewed and the tab, and a control that rebuilt the query from its own
 * state alone would navigate the reader somewhere they did not ask to go. A null or
 * empty value removes the parameter, so an unset filter leaves no trace in the URL —
 * `?q=&dept=` is a different link to the same view, and links are meant to be compared.
 */
export function mergeQuery(
  search: string,
  updates: Record<string, string | null | undefined>,
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }

  return params.toString();
}

/** {@link mergeQuery} for a range selection: sets `range`, clearing any stale ends. */
export function applyRangeToQuery(search: string, selection: RangeSelection): string {
  const cleared = mergeQuery(search, { from: null, to: null });
  return mergeQuery(cleared, rangeSearchParams(selection));
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/**
 * Moves the window by its own length. `delta` is in windows, not days.
 *
 * Always returns an absolute selection: "the seven days before last week" has no
 * preset name, and pretending otherwise is how a picker starts lying about what it
 * is showing.
 */
export function shiftRange(
  selection: RangeSelection,
  delta: number,
  now: Date = new Date(),
): RangeSelection {
  if (delta > 0 && !canShiftForward(selection, now)) return selection;

  const { start, end } = selectionDays(selection, now);
  const length = daysBetween(start, end) + 1;
  const step = delta * length;

  return { kind: "absolute", from: addDays(start, step), to: addDays(end, step) };
}

/** There is no data in the future, so the forward arrow stops at today. */
export function canShiftForward(selection: RangeSelection, now: Date = new Date()): boolean {
  const { end } = selectionDays(selection, now);
  return end < dayKey(now);
}

/** What the picker button reads. Deterministic — not `toLocaleDateString`. */
export function rangeLabel(selection: RangeSelection, now: Date = new Date()): string {
  if (selection.kind === "preset") return PRESET_LABEL[selection.preset];

  const today = dayKey(now);
  const yesterday = addDays(today, -1);

  if (selection.from === selection.to) {
    if (selection.from === today) return "Today";
    if (selection.from === yesterday) return "Yesterday";
    return formatDay(selection.from, true);
  }

  const sameYear = selection.from.slice(0, 4) === selection.to.slice(0, 4);
  return `${formatDay(selection.from, !sameYear)} – ${formatDay(selection.to, true)}`;
}

// ---------------------------------------------------------------------------
// Client-only preferences
// ---------------------------------------------------------------------------

/** Column visibility, keyed by table. TanStack Table's own state shape. */
export type ColumnVisibility = Record<string, boolean>;

interface FilterState {
  /** Used when a screen is opened with no range in the URL. A preference, not state. */
  defaultRange: DateRangePreset;
  columnVisibility: Record<string, ColumnVisibility>;
  setDefaultRange: (range: DateRangePreset) => void;
  setColumnVisibility: (table: string, visibility: ColumnVisibility) => void;
}

export const useFilters = create<FilterState>((set) => ({
  defaultRange: "today",
  columnVisibility: {},
  setDefaultRange: (defaultRange) => set({ defaultRange }),
  setColumnVisibility: (table, visibility) =>
    set((state) => ({ columnVisibility: { ...state.columnVisibility, [table]: visibility } })),
}));
