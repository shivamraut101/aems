"use client";

import { Button, Input, buttonVariants, cn } from "@aems/ui";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { ActivityTimeline } from "@/components/activity-timeline";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, ListSkeleton, StaleNotice } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { describeError, useApiQuery } from "@/lib/api";
import {
  DEFAULT_SLOT_SECONDS,
  alignedDayWindow,
  dateKeyOf,
  isFutureDateKey,
  rosterRows,
  shiftDateKey,
  useDayTimeline,
  type RosterRow,
  type RosterSort,
} from "@/lib/queries/activity";

import { LIVE_REFETCH_MS, employeesQuery, liveWorkforceQuery } from "./queries";

/**
 * Activity — the roster on the left, the selected person's day on the right.
 *
 * ActivTrak's master–detail, adopted: selecting a name never navigates, so a manager
 * scanning a team keeps their place in the list. Selection and date both live in the
 * URL, which makes every state of this screen a link somebody can send.
 *
 * `ActivityTimeline` is reused unchanged — there is exactly one timeline in this
 * product, and a second one would immediately disagree with the first.
 *
 * Below `lg` the two panes stack, and the roster is capped shorter than it is on a
 * desktop. That cap is the whole of the mobile design: an uncapped roster of thirty
 * people pushes the timeline — the thing the reader came for — a full screen and a half
 * down the page, and a phone gives no hint that anything is below it.
 */
export function ActivityView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const selectedId = params.get("profileId");
  const dateKey = params.get("date") ?? dateKeyOf(new Date());
  const [sort, setSort] = useState<RosterSort>("activity");

  const employees = useApiQuery(employeesQuery);
  const live = useApiQuery(liveWorkforceQuery, { refetchInterval: LIVE_REFETCH_MS });

  const rows = useMemo(
    () => rosterRows(employees.data ?? [], live.data ?? [], sort),
    [employees.data, live.data, sort],
  );

  /**
   * Presence is unreachable, and the roster must say so rather than imply it.
   *
   * `rosterRows` defaults a person with no presence row to `offline`, which is right
   * when the API answered and wrong when it did not: with `live` failing, every single
   * name renders "Offline" — a monitoring product asserting that nobody is working, on
   * the strength of a request that never landed. `live.data` survives a failed refetch,
   * so this is only true when there is genuinely nothing to show.
   */
  const presenceUnavailable = live.isError && live.data === undefined;
  const presenceNotice: PresenceNotice | null = live.isError
    ? {
        unavailable: presenceUnavailable,
        message: presenceUnavailable
          ? "Live presence could not be loaded, so no status is shown below. This is not a report that everyone is offline."
          : "Live presence stopped updating. The statuses below are the last ones received.",
        onRetry: () => void live.refetch(),
      }
    : null;

  function select(next: Partial<{ profileId: string; date: string }>) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) query.set(key, value);
    // `replace`, not `push`: clicking through eight people should not leave eight
    // entries for the back button to walk out of.
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  const selected = rows.find((row) => row.profileId === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader
        title="Activity"
        subtitle={rosterSummary(rows, employees.isLoading, presenceUnavailable)}
        actions={<DayNav dateKey={dateKey} onChange={(date) => select({ date })} />}
      />

      <div className="grid gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Roster
          rows={rows}
          selectedId={selectedId}
          sort={sort}
          onSort={setSort}
          loading={employees.isLoading}
          error={employees.isError ? describeError(employees.error) : null}
          onRetry={() => void employees.refetch()}
          presence={presenceNotice}
          onSelect={(profileId) => select({ profileId })}
        />

        {selectedId ? (
          <Detail
            profileId={selectedId}
            person={selected}
            dateKey={dateKey}
            presenceUnavailable={presenceUnavailable}
          />
        ) : (
          <NothingSelected hasPeople={rows.length > 0} />
        )}
      </div>
    </div>
  );
}

/**
 * The subtitle, as an answer rather than an instruction.
 *
 * "Pick someone to read their day" told a manager how to work the screen; it did not
 * tell them whether they needed to. The count is reduced from the rows already joined
 * for the list below — no second request, and therefore no second answer that could
 * disagree with the dots beside the names.
 *
 * **"Reporting", never "working".** The Overview's verdict says "N of M working" from
 * `workingToday`, which counts anyone who worked *at all today*; this counts who is
 * present *right now*. Two different questions, and a manager who clicks through from
 * one screen to the other must not read the two numbers as a contradiction.
 *
 * Falls back to the instruction while the roster is loading, when there is nobody, and
 * — the case that matters — whenever presence never landed: `rosterRows` defaults an
 * unknown person to `offline`, so this would otherwise read "Nobody is reporting right
 * now", which is a monitoring product asserting an outage as a fact about the business.
 */
function rosterSummary(rows: RosterRow[], loading: boolean, presenceUnavailable: boolean): string {
  if (loading || presenceUnavailable || rows.length === 0) {
    return "Pick someone to read their day without leaving the list.";
  }

  const reporting = rows.filter((row) => row.status !== "offline").length;
  return reporting === 0
    ? "Nobody is reporting right now."
    : `${reporting} of ${rows.length} reporting right now.`;
}

/* -------------------------------------------------------------------------- */
/* Day navigation                                                              */
/* -------------------------------------------------------------------------- */

function DayNav({ dateKey, onChange }: { dateKey: string; onChange: (date: string) => void }) {
  const today = dateKeyOf(new Date());
  const atToday = dateKey === today;

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => onChange(shiftDateKey(dateKey, -1))}
        aria-label="Previous day"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </Button>

      <Input
        type="date"
        value={dateKey}
        max={today}
        onChange={(event) => {
          const next = event.target.value;
          if (next && !isFutureDateKey(next)) onChange(next);
        }}
        aria-label="Day"
        className="tabular w-[9.5rem] shrink-0"
      />

      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => onChange(shiftDateKey(dateKey, 1))}
        disabled={atToday}
        aria-label="Next day"
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>

      {!atToday ? (
        // `h-9` overrides the `sm` size's `h-8`: 32px is under the touch floor, and it
        // also lines this up with the two arrows and the date field beside it.
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => onChange(today)}
        >
          Today
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Master pane                                                                 */
/* -------------------------------------------------------------------------- */

/** What to say about live presence, when there is something to say. */
interface PresenceNotice {
  /** Nothing landed at all — statuses must be withheld, not defaulted to offline. */
  unavailable: boolean;
  message: string;
  onRetry: () => void;
}

function Roster({
  rows,
  selectedId,
  sort,
  onSort,
  loading,
  error,
  onRetry,
  presence,
  onSelect,
}: {
  rows: RosterRow[];
  selectedId: string | null;
  sort: RosterSort;
  onSort: (sort: RosterSort) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  presence: PresenceNotice | null;
  onSelect: (profileId: string) => void;
}) {
  return (
    <section aria-label="Roster" className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {rows.length > 0 ? `${rows.length} people` : "People"}
        </h2>
        {/* Two sorts, deliberately. Cattr offers exactly these two and every extra one
            is a control a manager has to read past. */}
        <div className="flex items-center gap-0.5" role="group" aria-label="Sort roster">
          {(["activity", "name"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onSort(option)}
              aria-pressed={sort === option}
              className={cn(
                // `min-h-9` rather than padding alone: at `py-1` these were a 24px
                // target, which is under the 36px floor a thumb needs. The height is on
                // the button itself rather than an invisible overlay, so what is tappable
                // is exactly what is visible.
                "inline-flex min-h-9 items-center rounded px-2.5 text-xs capitalize transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                sort === option
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {/* Presence is a second, independent request. It failing must not blank the
          roster — the names, departments and enrolled devices are still true. */}
      {presence && !error && !loading ? (
        <StaleNotice message={presence.message} onRetry={presence.onRetry} />
      ) : null}

      {error ? (
        <ErrorState
          title="The roster could not be loaded"
          message={error}
          onRetry={onRetry}
          className="m-3"
        />
      ) : loading ? (
        <>
          <span className="sr-only" role="status">
            Loading the roster
          </span>
          <ListSkeleton rows={6} />
        </>
      ) : rows.length === 0 ? (
        <EmptyState
          bordered={false}
          title="No one to show yet"
          body="People appear here once they are added to your company."
          // `/activity` and `/people` carry the same role set in `session.ts`, so
          // anyone who can read this screen can also open the one that fixes it.
          action={
            <Link
              href="/people"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9")}
            >
              Add people
            </Link>
          }
        />
      ) : (
        <ul className="max-h-[20rem] divide-y overflow-y-auto lg:max-h-[70vh]">
          {rows.map((row) => {
            const active = row.profileId === selectedId;
            // A 19rem column truncates most device names and half the long ones, and a
            // roster is exactly where "Sarah's MacBook Pro (Design)" and "Sarah's
            // MacBook Air" clip to the same string. The full value goes in `title`.
            const trailing = row.monitoringEnabled
              ? (row.deviceLabel ?? row.department ?? "")
              : "Monitoring paused";

            return (
              <li key={row.profileId}>
                <button
                  type="button"
                  onClick={() => onSelect(row.profileId)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "w-full px-3 py-2.5 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={row.name}>
                      {row.name}
                    </span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      <RelativeTime iso={row.lastSeenAt} />
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    {presence?.unavailable ? (
                      <span className="text-xs italic text-muted-foreground">Status unknown</span>
                    ) : (
                      <StatusDot status={row.status} className="text-xs text-muted-foreground" />
                    )}
                    <span className="truncate text-xs text-muted-foreground" title={trailing}>
                      {trailing}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail pane                                                                 */
/* -------------------------------------------------------------------------- */

function Detail({
  profileId,
  person,
  dateKey,
  presenceUnavailable,
}: {
  profileId: string;
  person: RosterRow | null;
  dateKey: string;
  presenceUnavailable: boolean;
}) {
  const today = dateKey === dateKeyOf(new Date());
  const [tick, setTick] = useState(0);

  // Today's window ends at "now", so it has to move. Recomputing it on every render
  // instead would mint a new query key each pass and refetch forever.
  useEffect(() => {
    if (!today) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [today]);

  /**
   * `tick` is the dependency that matters here: it is the clock, and dropping it would
   * freeze today's window at the moment the screen first rendered.
   *
   * `alignedDayWindow`, not `dayWindow`: the latter ends at a millisecond-precise "now",
   * so each of these ticks produced a window — and therefore a query key — that had
   * never been requested before, and the timeline was thrown away and re-skeletoned once
   * a minute. Quantised to the slot grid the key changes once per slot, and
   * `useDayTimeline` keeps the previous day on screen while the next one loads.
   */
  const range = useMemo(
    () => alignedDayWindow(dateKey, DEFAULT_SLOT_SECONDS),
    [dateKey, tick],
  );

  const { data, isLoading, isError, error, refetch } = useDayTimeline(profileId, range.from, range.to);

  return (
    <section aria-label="Day detail" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-tight">
            {person?.name ?? "Selected person"}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {person && !presenceUnavailable ? (
              <StatusDot status={person.status} className="text-sm" />
            ) : null}
            {presenceUnavailable ? <span className="italic">Status unknown</span> : null}
            {person?.department ? <span>{person.department}</span> : null}
          </p>
        </div>

        {/* The same day, on the full employee page. Their timeline tab reads `date` and
            treats its absence as today, so today omits it rather than pinning a key that
            goes stale the moment the clock rolls over. */}
        <Link
          href={`/people/${profileId}/timeline${today ? "" : `?date=${dateKey}`}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9 shrink-0")}
        >
          Open full page
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {/* The whole day goes to the component, which owns the ribbon, the rail, the
          totals strip and its own loading / error / empty states. Reducing any of it
          here would be a second answer to the same question. */}
      <ActivityTimeline
        timeline={data ?? null}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyHint={
          today
            ? "Nothing has been reported today yet. Activity appears as the agent syncs."
            : "No activity was reported on this day."
        }
      />
    </section>
  );
}

function NothingSelected({ hasPeople }: { hasPeople: boolean }) {
  return (
    <section aria-label="Day detail" className="grid min-w-0 place-items-center lg:min-h-[18rem]">
      <EmptyState
        className="w-full"
        title={hasPeople ? "Select someone to read their day" : "Nothing to read yet"}
        body={
          hasPeople
            ? "Their timeline opens here — the list stays where it is, and the link in your address bar carries the selection."
            : "Once an agent reports its first session, the day appears here."
        }
      />
    </section>
  );
}
