"use client";

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aems/ui";
import Link from "next/link";

import { RelativeTime } from "@/components/relative-time";
import { EmptyState } from "@/components/states";
import { describeError, isSessionExpired, useLiveWorkforce } from "@/lib/api";
import { timeOfDay } from "@/lib/format";

const PLATFORM_LABEL = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
} as const;

/**
 * Presence as a pill, in the vocabulary the rest of the dashboard already uses.
 *
 * The `dot` is the state marker `Badge` reserves for things a person is *doing* — the
 * same signal `StatusDot` carried before, now drawn once in the design system instead
 * of once per screen. The word always travels with the colour, so the state survives
 * without colour vision.
 */
const STATUS_BADGE = {
  active: { variant: "online", label: "Active" },
  idle: { variant: "warning", label: "Idle" },
  offline: { variant: "offline", label: "Offline" },
} as const;

/**
 * Who is working right now.
 *
 * A table rather than a grid of cards: this is an operational list people scan
 * top-to-bottom looking for the one name that is wrong.
 */
export function LiveWorkforce() {
  const { data, isLoading, isError, error, refetch, isFetching } = useLiveWorkforce();

  if (isError) {
    // `/api/analytics/live` is behind `requireManager`, so 401 and 403 are both
    // reachable here — and "check that the API is running" told a manager whose
    // session had simply expired to go and inspect a server. `role="alert"` because
    // this strip polls: it can fail while the reader is looking somewhere else.
    const expired = isSessionExpired(error);

    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
      >
        <p className="text-sm">{describeError(error)}</p>

        {expired ? (
          // Retrying a 401 just spends another round trip to be refused again.
          <Link
            href="/login"
            className="rounded-md border bg-card px-2.5 py-1 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sign in
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded-md border bg-card px-2.5 py-1 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isFetching ? "Retrying" : "Try again"}
          </button>
        )}
      </div>
    );
  }

  if (!isLoading && (!data || data.length === 0)) {
    // The endpoint is driven by `profiles`, not by devices, so an empty answer means
    // the roster is empty — not that nobody has installed anything. The old copy sent
    // an admin off to install an agent for a person who does not exist yet.
    return (
      <EmptyState
        title="Nobody on the roster yet"
        body="Add the people you monitor, then install the desktop agent on their machines. Each person appears here as soon as their agent reports in."
        action={
          <Link
            href="/people"
            className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go to People
          </Link>
        }
      />
    );
  }

  // Everyone offline with no device anywhere is the commonest reading on a fresh
  // install, and the row-level "No device enrolled" does not add up to the sentence a
  // reader needs. Said once under the table rather than once per row.
  const noneEnrolled = data?.every((row) => row.deviceId === null) ?? false;

  return (
    <>
      <Table containerClassName="rounded-lg border bg-card">
        <caption className="sr-only">Live employee status</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">Employee</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col" className="hidden sm:table-cell">
              Device
            </TableHead>
            <TableHead scope="col" className="text-right">
              Last sync
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading
            ? Array.from({ length: 4 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={4}>
                    <span className="block h-4 w-full animate-pulse rounded bg-muted" aria-hidden />
                  </TableCell>
                </TableRow>
              ))
            : data?.map((row) => {
                const badge = STATUS_BADGE[row.status];
                // Both are nullable on the wire. Without the fallback the primary cell
                // renders an empty link — a row you cannot read and cannot click.
                const name = row.fullName || row.email || "Unnamed person";
                const device =
                  row.platform && row.label
                    ? `${PLATFORM_LABEL[row.platform]} · ${row.label}`
                    : null;

                return (
                  <TableRow key={row.profileId}>
                    <TableCell>
                      <Link
                        href={`/people/${row.profileId}`}
                        // A long email is the usual value here and it is the column
                        // that would otherwise push the table past a phone's width.
                        // The clamp is on the anchor rather than the cell: a `<td>`
                        // max-width is advisory under auto table layout, so putting it
                        // there truncates nothing and the column grows anyway.
                        title={name}
                        className="block max-w-[10rem] truncate font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[15rem]"
                      >
                        {name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge variant={badge.variant} dot>
                          {badge.label}
                        </Badge>
                        {row.idleSince ? (
                          <span className="tabular text-xs text-muted-foreground">
                            since {timeOfDay(row.idleSince)}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {device ? (
                        <span className="block max-w-[15rem] truncate" title={device}>
                          {device}
                        </span>
                      ) : (
                        // Someone on the roster who has not enrolled anything. Saying so
                        // is the point of listing them: an admin needs to see who is not
                        // set up yet, which the device-driven version could never show.
                        <span className="text-muted-foreground/70">No device enrolled</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      <RelativeTime iso={row.lastSeenAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
        </TableBody>
      </Table>

      {noneEnrolled ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Nobody has enrolled a device yet, so everyone reads as offline. Install the desktop
          agent on a company machine and its first heartbeat fills this in.
        </p>
      ) : null}
    </>
  );
}
