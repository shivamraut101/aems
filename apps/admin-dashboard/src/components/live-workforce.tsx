"use client";

import Link from "next/link";

import { useLiveWorkforce } from "@/lib/api";
import { relativeTime, timeOfDay } from "@/lib/format";

import { StatusDot } from "./status-dot";

const PLATFORM_LABEL = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
} as const;

/**
 * Who is working right now.
 *
 * A table rather than a grid of cards: this is an operational list people scan
 * top-to-bottom looking for the one name that is wrong.
 */
export function LiveWorkforce() {
  const { data, isLoading, isError } = useLiveWorkforce();

  if (isError) {
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        Live status is unavailable. Check that the API is running.
      </p>
    );
  }

  if (!isLoading && (!data || data.length === 0)) {
    return (
      <div className="rounded-lg border bg-card px-4 py-8 text-center">
        <p className="text-sm font-medium">No devices enrolled yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Install the desktop agent on a company machine to see activity here.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <table className="w-full text-sm">
        <caption className="sr-only">Live employee status</caption>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">
              Employee
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
              Device
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Last sync
            </th>
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? Array.from({ length: 4 }, (_, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td colSpan={4} className="px-4 py-2.5">
                    <span className="block h-4 w-full animate-pulse rounded bg-muted" />
                  </td>
                </tr>
              ))
            : data?.map((row) => (
                <tr key={row.deviceId} className="border-b transition-colors last:border-0 hover:bg-secondary/40">
                  <td className="px-4 py-2.5">
                    {row.profileId ? (
                      <Link
                        href={`/people/${row.profileId}`}
                        className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {row.fullName || row.email}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.label}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusDot status={row.status} />
                    {row.idleSince ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        since {timeOfDay(row.idleSince)}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                    {PLATFORM_LABEL[row.platform]} · {row.label}
                  </td>
                  <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                    {relativeTime(row.lastSeenAt)}
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
