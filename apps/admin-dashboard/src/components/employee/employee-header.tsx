"use client";

import { Badge } from "@aems/ui";
import { ArrowLeft, EyeOff } from "lucide-react";
import Link from "next/link";

import { RelativeTime } from "@/components/relative-time";
import { ErrorState, StaleNotice, queryViewState } from "@/components/states";
import { describeError, useApiQuery, useLiveWorkforce } from "@/lib/api";
import { timeOfDay } from "@/lib/format";

import { DayRangeControl } from "./day-range-control";
import { employeeQuery } from "./employee-queries";
import { displayName, initials, subtitleFor } from "./identity";
import { platformLabel, resolvePresence, type PresenceStatus } from "./presence";
import { useDayWindow } from "./use-day-window";

/**
 * Presence as a pill rather than as a dot beside a word.
 *
 * It is a *state* — what the person is doing right now — so it takes the badge with
 * the leading dot, the same treatment every other state in the product gets. On this
 * header it is also the one fact a reader is looking for before any other, and a pill
 * is what makes it findable in a row of plain label/value pairs.
 */
const PRESENCE: Record<PresenceStatus, { variant: "success" | "warning" | "offline"; label: string }> =
  {
    active: { variant: "success", label: "Active" },
    idle: { variant: "warning", label: "Idle" },
    offline: { variant: "offline", label: "Offline" },
  };

/**
 * The identity block from docs/design.md:112-120 — avatar, name, role, live status,
 * device, last sync.
 *
 * The record is read through `employeeQuery`, the same spec the route's layout warms
 * server-side, so on a normal navigation this component's first render already has
 * the person: no skeleton, no swap, the name is in the HTML. The loading branch below
 * survives for the cases where it is true — a cold cache after a failed prefetch, or
 * the API refusing.
 *
 * Presence is joined from two places on purpose. The employee record knows which
 * devices exist and when each last reported; only the live board joins the open
 * `idle_events` row, which is the only thing that can produce scope §4.3's amber Idle
 * state. If the live call is unavailable this still says Active or Offline rather than
 * showing nothing.
 */
export function EmployeeHeader({ profileId }: { profileId: string }) {
  const day = useDayWindow();
  const query = useApiQuery(employeeQuery(profileId), { enabled: Boolean(profileId) });
  // Shares the ["analytics","live"] cache with the Overview page's live strip, so
  // opening a person costs no extra request when the manager came from there.
  const { data: live } = useLiveWorkforce();

  // Never a hand-rolled ternary chain: `stale` — a failed background refresh with the
  // person still on screen — is a different answer from `error`, and replacing a
  // rendered header with a red box because one refetch lost the network is worse than
  // saying the figures are a minute old.
  const state = queryViewState(query);

  if (state === "error") {
    return (
      <div className="px-4 py-6 sm:px-6">
        <BackLink />
        <div className="mt-4">
          <ErrorState
            title="Could not load this employee"
            message={describeError(query.error)}
            onRetry={() => void query.refetch()}
          />
        </div>
      </div>
    );
  }

  const employee = query.data;
  if (!employee) return <HeaderSkeleton />;

  const presence = resolvePresence(employee.devices, live ?? []);
  const name = displayName(employee);

  return (
    <div className="px-4 pb-4 pt-6 sm:px-6">
      {state === "stale" ? (
        <StaleNotice
          className="mb-3 rounded-md border"
          message="This record could not be refreshed — what you are reading is the last answer the API gave."
          onRetry={() => void query.refetch()}
        />
      ) : null}

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
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {subtitleFor(employee.role, employee.department)}
            </p>
          </div>
        </div>

        {/* The day is resolved in the browser's clock, so it is absent for one frame.
            The placeholder matches the control's own box — full width below `sm`, where
            it takes a line of its own — so the header does not grow a row when it
            arrives. */}
        {day ? (
          <DayRangeControl day={day} />
        ) : (
          <span className="h-9 w-full sm:w-auto" aria-hidden />
        )}
      </div>

      <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Status</dt>
          <dd>
            <Badge variant={PRESENCE[presence.status].variant} dot>
              {PRESENCE[presence.status].label}
            </Badge>
          </dd>
        </div>

        {/* The unambiguous identifier, and the reason the tooltip that used to hide it
            on the role line was worth replacing: two people can share a display name,
            and a manager acting on this page needs to know which one they have. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Email</dt>
          <dd className="min-w-0 truncate text-muted-foreground" title={employee.email}>
            {employee.email}
          </dd>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="shrink-0 text-muted-foreground">Device</dt>
          {/* Truncates rather than pushing the row wider than the phone it is on, with
              the full name on the title for the laptops named after a serial number. */}
          <dd
            className="min-w-0 truncate font-medium"
            title={presence.device ? deviceLine(presence.device) : undefined}
          >
            {presence.device ? deviceLine(presence.device) : "None enrolled"}
          </dd>
        </div>

        <div className="flex items-center gap-1.5">
          <dt className="text-muted-foreground">Last sync</dt>
          <dd className="tabular font-medium">
            <RelativeTime iso={presence.lastSeenAt} />
          </dd>
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

/** "MacBook Pro · macOS" — the device, and which platform it speaks. */
function deviceLine(device: { label: string; platform: Parameters<typeof platformLabel>[0] }): string {
  return `${device.label} · ${platformLabel(device.platform)}`;
}

/**
 * Matches `HeaderFallback` in the route's layout exactly, so the one path that still
 * loads settles through one height rather than two.
 */
function HeaderSkeleton() {
  return (
    <div className="px-4 py-6 sm:px-6">
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

/**
 * Back to the roster.
 *
 * `h-9` and a negative left margin: the link is a standalone navigation control rather
 * than a word inside a sentence, so it takes a 36px target, and pulling the padding
 * back out keeps its text on the page's gutter instead of indenting it by 8px.
 */
function BackLink() {
  return (
    <Link
      href="/people"
      className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      People
    </Link>
  );
}
