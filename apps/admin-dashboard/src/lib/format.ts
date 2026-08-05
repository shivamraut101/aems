/** Display helpers. Durations render as "8h 20m" everywhere, per docs/design.md. */

export function duration(seconds: number): string {
  if (seconds <= 0) return "0m";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * "12 seconds ago" — used for last-sync and last-heartbeat readouts.
 *
 * `now` is a parameter rather than a call to `Date.now()` inside, because reading the
 * clock during render made this function unsafe to server-render. The server wrote
 * "12 seconds ago" into the HTML, the browser hydrated a moment later and computed
 * "15 seconds ago", and React — finding text it did not expect — discarded the entire
 * server-rendered tree and rebuilt the page on the client. Every page carrying a
 * last-seen column did that, which is most of them, and it threw away the server
 * prefetching that exists to make the first paint the real one.
 *
 * Prefer the `<RelativeTime>` component over calling this directly: it supplies a
 * `now` that the server and the hydrating client agree on, then switches to the live
 * clock once mounted. The default argument is kept for tests and for the rare
 * caller that is already past hydration.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";

  const deltaSeconds = Math.round((now - Date.parse(iso)) / 1000);
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds} seconds ago`;

  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function longDate(date = new Date()): string {
  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
