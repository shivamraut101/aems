/**
 * The seven sections of scope §4.4, as routes rather than as component state.
 *
 * A route each is what makes every section linkable, makes browser back work, and —
 * the reason it was worth doing on day one — makes the employee transparency view
 * (`/me`) a matter of pinning `profileId` to the session rather than a second
 * implementation of the same seven screens.
 */

export interface EmployeeTab {
  href: string;
  label: string;
  /** Icon identity; the component map lives with the tab strip, not here. */
  icon: EmployeeTabIcon;
}

export type EmployeeTabIcon =
  | "overview"
  | "timeline"
  | "screenshots"
  | "apps"
  | "websites"
  | "reports"
  | "devices";

export function employeeTabs(profileId: string): EmployeeTab[] {
  // Encoded so an id carrying a slash cannot invent a path segment. Real ids are
  // UUIDs; this is about what a hand-edited URL can do, not about what the API sends.
  const base = `/people/${encodeURIComponent(profileId)}`;

  return [
    { href: base, label: "Overview", icon: "overview" },
    { href: `${base}/timeline`, label: "Timeline", icon: "timeline" },
    { href: `${base}/screenshots`, label: "Screenshots", icon: "screenshots" },
    { href: `${base}/apps`, label: "Apps", icon: "apps" },
    { href: `${base}/websites`, label: "Websites", icon: "websites" },
    { href: `${base}/reports`, label: "Reports", icon: "reports" },
    { href: `${base}/devices`, label: "Devices", icon: "devices" },
  ];
}

/** Is `pathname` this tab, or somewhere underneath it? */
function covers(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Which tab a path belongs to, or null when none does.
 *
 * Longest match wins. Overview is the prefix of every other tab, so a plain
 * `startsWith` lights it on all seven — the same defect that lit "My activity" on
 * "/members", and the reason the segment boundary is checked rather than the string.
 */
export function activeTabHref(
  pathname: string,
  tabs: readonly EmployeeTab[],
): string | null {
  let best: string | null = null;

  for (const tab of tabs) {
    if (!covers(tab.href, pathname)) continue;
    if (best === null || tab.href.length > best.length) best = tab.href;
  }

  return best;
}

/**
 * Carries the query string across a tab change.
 *
 * Without this, moving from Overview to Timeline silently resets the day to today —
 * the manager loses the thing they were looking at and has to find it again.
 */
export function withSearch(href: string, search: string | null | undefined): string {
  const query = (search ?? "").replace(/^\?/, "");
  return query.length > 0 ? `${href}?${query}` : href;
}

/**
 * The same path, showing a different day.
 *
 * `date` is null for today, which *removes* the parameter rather than writing it. The
 * default URL stays `/people/:id` — the link a manager pastes into a message keeps
 * meaning "today" tomorrow, instead of freezing on the day it was copied.
 */
export function dayHref(
  pathname: string,
  search: string | null | undefined,
  date: string | null,
): string {
  const params = new URLSearchParams((search ?? "").replace(/^\?/, ""));
  if (date === null) params.delete("date");
  else params.set("date", date);

  const query = params.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}
