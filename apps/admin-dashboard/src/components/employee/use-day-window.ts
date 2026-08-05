"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { resolveDay, type DayWindow } from "./day-window";

/**
 * The day this page is showing, read from `?date=` and resolved in the browser's clock.
 *
 * Null until mount, deliberately. "Local midnight" and "today" are different instants
 * on the server (another clock, almost certainly UTC) than in the reader's browser, so
 * resolving during the server render would hydrate a different window than it painted
 * — and the query key derived from it would shift under the first effect, throwing
 * away the fetch that had already started.
 *
 * Nothing is lost by waiting: the data itself is client-fetched, so the server render
 * is a skeleton either way.
 *
 * Shared by every tab on this page so all seven agree about which day they are showing.
 */
export function useDayWindow(): DayWindow | null {
  const search = useSearchParams();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return mounted ? resolveDay(search.get("date")) : null;
}
