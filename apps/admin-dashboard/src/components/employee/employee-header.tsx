"use client";

import { Badge } from "@aems/ui";
import { ArrowLeft, EyeOff } from "lucide-react";
import Link from "next/link";

import { StatusDot } from "@/components/status-dot";
import { describeError, useLiveWorkforce } from "@/lib/api";
import { relativeTime, timeOfDay } from "@/lib/format";
import { useEmployee } from "@/lib/queries/employee";

import { DayRangeControl } from "./day-range-control";
import { displayName, initials, subtitleFor } from "./identity";
import { platformLabel, resolvePresence } from "./presence";
import { ErrorState } from "./states";
import { useDayWindow } from "./use-day-window";

/**
 * The identity block from docs/design.md:112-120 — avatar, name, role, live status,
 * device, last sync.
 *
 * Presence is joined from two places on purpose. The employee record knows which
 * devices exist and when each last reported; only the live board joins the open
 * `idle_events` row, which is the only thing that can produce scope §4.3's amber Idle
 * state. If the live call is unavailable this still says Active or Offline rather than
 * showing nothing.
 */
export function EmployeeHeader({ profileId }: { profileId: string }) {
  const day = useDayWindow();
  const { data: employee, isLoading, isError, error, refetch } = useEmployee(profileId);
  // Shares the ["analytics","live"] cache with the Overview page's live strip, so
  // opening a person costs no extra request when the manager came from there.
  const { data: live } = useLiveWorkforce();

  if (isError) {
    return (
      <div className="px-6 py-6">
        <BackLink />
        <div className="mt-4">
          <ErrorState
            title="Could not load this employee"
            message={describeError(error)}
            onRetry={() => void refetch()}
          />
        </div>
      </div>
    );
  }

  if (isLoading || !employee) {
    return (
      <div className="px-6 py-6">
        <BackLink />
        <div className="mt-4 flex items-center gap-4" aria-hidden>
          <span className="h-12 w-12 animate-pulse rounded-full bg-muted" />
          <div className="space-y-2">
            <span className="block h-5 w-44 animate-pulse rounded bg-muted" />
            <span className="block h-3.5 w-28 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  const presence = resolvePresence(employee.devices, live ?? []);
  const name = displayName(employee);

  return (
    <div className="px-6 pb-4 pt-6">
      <BackLink />

      <div className="mt-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          >
            {initials(name)}
          </span>

          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-0.5 truncate text-sm text-muted-foreground" title={employee.email}>
              {subtitleFor(employee.role, employee.department)}
            </p>
          </div>
        </div>

        {/* The day is resolved in the browser's clock, so it is absent for one frame.
            A fixed-height placeholder keeps the header from jumping when it arrives. */}
        {day ? <DayRangeControl day={day} /> : <span className="h-9" aria-hidden />}
      </div>

      <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Status</dt>
          <dd>
            <StatusDot status={presence.status} />
          </dd>
        </div>

        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">Device</dt>
          <dd className="font-medium">
            {presence.device
              ? `${presence.device.label} · ${platformLabel(presence.device.platform)}`
              : "None enrolled"}
          </dd>
        </div>

        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">Last sync</dt>
          <dd className="tabular font-medium">{relativeTime(presence.lastSeenAt)}</dd>
        </div>

        {presence.idleSince ? (
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Idle since</dt>
            <dd className="tabular font-medium">{timeOfDay(presence.idleSince)}</dd>
          </div>
        ) : null}

        {/* Monitoring being off is the single most important fact about a page with no
            data on it. Saying so turns an apparently broken screen into an answer. */}
        {employee.monitoring_enabled ? null : (
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Monitoring</dt>
            <dd>
              <Badge variant="offline" className="gap-1">
                <EyeOff className="h-3 w-3" aria-hidden />
                Monitoring paused
              </Badge>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/people"
      className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      People
    </Link>
  );
}
