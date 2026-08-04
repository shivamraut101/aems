/**
 * Formatting for the status readout.
 *
 * Every function here is pure and takes the clock as an argument. The readout
 * reticks once a second, so a formatter that read `Date.now()` itself would produce
 * a different answer on every render and could not be reasoned about or tested.
 */

/** "7h 12m", "45m" — the shape docs/design.md uses for tracked time. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * "30 seconds", "5 minutes", "1 hour".
 *
 * Separate from `formatDuration` because the consent copy puts these inside
 * sentences, and "screenshots every 0h 5m" is not a sentence.
 */
export function formatSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a set interval";
  if (seconds < 60) return plural(Math.round(seconds), "second");
  if (seconds < 3600) return plural(Math.round(seconds / 60), "minute");
  return plural(Math.round(seconds / 3600), "hour");
}

/** "10 seconds ago", "4 minutes ago". Null when the timestamp is unparseable. */
export function formatRelative(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;

  const seconds = Math.round((now - at) / 1000);

  // A device clock a few seconds ahead of the API's is ordinary; reporting a sync
  // "in 3 seconds" would read as a bug rather than the skew it is.
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${plural(seconds, "second")} ago`;
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), "minute")} ago`;
  if (seconds < 86400) return `${plural(Math.floor(seconds / 3600), "hour")} ago`;
  return `${plural(Math.floor(seconds / 86400), "day")} ago`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
