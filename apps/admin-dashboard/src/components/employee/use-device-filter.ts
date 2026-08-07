"use client";

import { useSearchParams } from "next/navigation";

/**
 * Which device this page is narrowed to, read from `?device=`. Null means all of them.
 *
 * Held in the URL for the same reason `?date=` is: a manager who has scrubbed to
 * Tuesday on the field phone and wants to send that view to somebody has to be able
 * to send the address bar. It also survives a tab change, so moving from Timeline to
 * Screenshots keeps both the day and the machine — the two questions a manager is
 * holding at once.
 *
 * Deliberately NOT validated against the person's device list here. A stale id in a
 * pasted link is answered by the API with an empty day rather than by this hook with
 * a guess, and an empty day is the honest answer: that device recorded nothing for
 * that person. Rewriting the URL to "all devices" would silently show a wider set than
 * the link asked for, which on this screen means showing activity from a machine the
 * reader did not ask about.
 *
 * Unlike `useDayWindow` there is no mount gate. A device id is the same string on the
 * server and in the browser — it is not resolved against a clock — so there is nothing
 * for hydration to disagree about.
 */
export function useDeviceFilter(): string | null {
  const search = useSearchParams();
  const value = search.get("device");
  return value === null || value.length === 0 ? null : value;
}

/**
 * The same URL with a different device selected, preserving everything else.
 *
 * Mirrors `dayHref`. The two controls sit beside each other and write to the same
 * query string, so each has to leave the other's parameter alone — a device switch
 * that dropped `?date=` would throw the reader back to today mid-investigation.
 */
export function deviceHref(
  pathname: string,
  search: string | null | undefined,
  deviceId: string | null,
): string {
  const params = new URLSearchParams((search ?? "").replace(/^\?/, ""));
  if (deviceId === null) params.delete("device");
  else params.set("device", deviceId);

  const query = params.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}
