import * as FileSystem from "expo-file-system";

import type { ActivityEventInput, BreakEventInput, LocationPointInput } from "@aems/types";

/**
 * Events written to disk before they are sent, and removed only once the API has
 * confirmed them.
 *
 * The agent previously had no buffer at all. What made that survivable was a side
 * effect rather than a design: `syncActivity` only advanced its query window after a
 * successful send, so a failed cycle re-queried the same window next time. That covers
 * a dropped request and nothing else — it does not cover the app being killed, and it
 * cannot cover a *break* event at all, because a break is not something
 * `UsageStatsManager` can be re-asked for. Once observed, it exists only here.
 *
 * The desktop agent journals to `state/pending-events.ndjson` for exactly this reason.
 * This is the same idea in the shape Expo gives us: one JSON file, rewritten whole.
 * Rewriting rather than appending is a deliberate trade — these batches are small and
 * bounded by `MAX_PENDING`, and a partially-appended line after a kill is a corrupt
 * journal, which is a worse failure than an occasional full write.
 */

const QUEUE_URI = `${FileSystem.documentDirectory}pending-events.json`;

/**
 * Beyond this the oldest entries are dropped.
 *
 * An unbounded journal on a phone that has been offline for a week is a disk-space
 * problem that ends with the OS killing the app — losing the oldest events is the
 * lesser harm, and it is logged rather than silent.
 */
const MAX_PENDING = 2000;

export interface PendingEvents {
  activity: ActivityEventInput[];
  breaks: BreakEventInput[];
  locations: LocationPointInput[];
}

export const NO_PENDING: PendingEvents = { activity: [], breaks: [], locations: [] };

export function pendingCount(pending: PendingEvents): number {
  return pending.activity.length + pending.breaks.length + pending.locations.length;
}

export async function loadPending(): Promise<PendingEvents> {
  try {
    const info = await FileSystem.getInfoAsync(QUEUE_URI);
    if (!info.exists) return NO_PENDING;

    const parsed = JSON.parse(await FileSystem.readAsStringAsync(QUEUE_URI)) as PendingEvents;
    // Each field defaulted separately: a journal written by an older build has no
    // `locations` key at all, and reading it must not throw away the events it does have.
    return {
      activity: parsed.activity ?? [],
      breaks: parsed.breaks ?? [],
      locations: parsed.locations ?? [],
    };
  } catch {
    // An unreadable journal is dropped rather than retried forever. Re-reading a file
    // that will not parse on every cycle is a worse outcome than losing what it held.
    return NO_PENDING;
  }
}

async function writePending(pending: PendingEvents): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(QUEUE_URI, JSON.stringify(pending));
  } catch {
    // Nothing useful to do: the events stay in memory for this cycle and the next
    // enqueue will try the file again.
  }
}

/**
 * Adds events to the journal, de-duplicated on `clientEventId`.
 *
 * The same id is what the ingestion endpoint uses to reject a duplicate, so keeping
 * the invariant on this side too means a retried cycle cannot inflate the queue.
 */
export async function enqueue(events: Partial<PendingEvents>): Promise<PendingEvents> {
  const current = await loadPending();

  const merged: PendingEvents = {
    activity: dedupe([...current.activity, ...(events.activity ?? [])]),
    breaks: dedupe([...current.breaks, ...(events.breaks ?? [])]),
    locations: dedupe([...current.locations, ...(events.locations ?? [])]),
  };

  const trimmed: PendingEvents = {
    activity: merged.activity.slice(-MAX_PENDING),
    breaks: merged.breaks.slice(-MAX_PENDING),
    locations: merged.locations.slice(-MAX_PENDING),
  };

  const dropped = pendingCount(merged) - pendingCount(trimmed);
  if (dropped > 0) {
    console.warn(`[aems] pending queue full — dropped ${dropped} oldest event(s)`);
  }

  await writePending(trimmed);
  return trimmed;
}

/** Called only after the API has accepted the batch. */
export async function clearPending(): Promise<void> {
  await FileSystem.deleteAsync(QUEUE_URI, { idempotent: true }).catch(() => {
    // Failing to delete would replay accepted events; the server's `clientEventId`
    // check discards them, so this is safe to swallow.
  });
}

function dedupe<T extends { clientEventId: string }>(events: T[]): T[] {
  const seen = new Map<string, T>();
  for (const event of events) seen.set(event.clientEventId, event);
  return [...seen.values()];
}
