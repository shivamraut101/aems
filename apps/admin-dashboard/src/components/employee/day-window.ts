/**
 * The day the employee page is showing, derived from `?date=` in the URL.
 *
 * URL-as-state, per ActivityWatch: every day a manager can reach is a link they can
 * paste into a report, and browser back works. Nothing about the range lives in
 * component state or in Zustand — mirroring it there is how two tabs end up showing
 * different days while claiming to show the same one.
 *
 * Boundaries are the *viewer's* local midnight today. The subject's own timezone is a
 * column that does not exist yet (`profiles.timezone`, after the demo); until it does,
 * pretending to know an employee's midnight would be a worse answer than this one.
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DayWindow {
  /** `YYYY-MM-DD` on the viewer's calendar. The value that belongs in `?date=`. */
  date: string;
  /** Local midnight, ISO 8601 with an offset — what the API's validator requires. */
  from: string;
  /** The next local midnight. Half-open, so two days never share a second. */
  to: string;
  /** "Wednesday, 5 August" — a bare ISO date is not a reading experience. */
  label: string;
  isToday: boolean;
  previous: string;
  /** Null on today: there is no future day to look at, so the control is disabled. */
  next: string | null;
}

/** A local calendar date as `YYYY-MM-DD`. `toISOString` would give the UTC one. */
export function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Moves a `YYYY-MM-DD` by whole days, crossing months and years correctly. */
export function shiftDay(date: string, days: number): string {
  const parsed = parseDay(date);
  if (!parsed) return date;

  parsed.setDate(parsed.getDate() + days);
  return isoDate(parsed);
}

/**
 * Parses `YYYY-MM-DD` as a *local* date.
 *
 * `new Date("2026-08-05")` is UTC midnight by specification, which is the previous
 * evening west of Greenwich — the whole day would be off by one for half the world.
 * Rejects a value the calendar rolled over (`2026-02-30` becoming 2 March), because a
 * date nobody typed is not a date to show.
 */
function parseDay(value: string): Date | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function resolveDay(dateParam: string | null | undefined, now: Date = new Date()): DayWindow {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const requested = dateParam ? parseDay(dateParam) : null;

  // A future date is either a typo or a stale link. Falling back to today shows
  // something real; a tomorrow full of "offline" would look like a broken agent.
  const start = requested && requested.getTime() <= today.getTime() ? requested : today;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
  const date = isoDate(start);
  const isToday = date === isoDate(today);

  return {
    date,
    from: start.toISOString(),
    to: end.toISOString(),
    label: start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
    isToday,
    previous: shiftDay(date, -1),
    next: isToday ? null : shiftDay(date, 1),
  };
}
