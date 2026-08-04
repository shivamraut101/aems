import { useEffect, useState } from "react";

/**
 * A clock that re-renders on an interval.
 *
 * Main pushes status only when something changes, so "Last Sync" would otherwise
 * freeze at whatever it said when the last event landed — and a stale "10 seconds
 * ago" is worse than no figure at all, because it claims the agent is healthy.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
