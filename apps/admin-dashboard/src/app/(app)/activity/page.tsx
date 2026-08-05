"use client";

import { cn } from "@aems/ui";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { ActivityTimeline } from "@/components/activity-timeline";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { describeError, useEmployees, useLiveWorkforce } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import {
  dateKeyOf,
  dayWindow,
  isFutureDateKey,
  rosterRows,
  shiftDateKey,
  useDayTimeline,
  type RosterRow,
  type RosterSort,
} from "@/lib/queries/activity";

/**
 * Activity — the roster on the left, the selected person's day on the right.
 *
 * ActivTrak's master–detail, adopted: selecting a name never navigates, so a manager
 * scanning a team keeps their place in the list. Selection and date both live in the
 * URL, which makes every state of this screen a link somebody can send.
 *
 * `ActivityTimeline` is reused unchanged — there is exactly one timeline in this
 * product, and a second one would immediately disagree with the first.
 */
export default function ActivityPage() {
  return (
    <Suspense fallback={<ActivitySkeleton />}>
      <ActivityScreen />
    </Suspense>
  );
}

function ActivityScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const selectedId = params.get("profileId");
  const dateKey = params.get("date") ?? dateKeyOf(new Date());
  const [sort, setSort] = useState<RosterSort>("activity");

  const employees = useEmployees();
  const live = useLiveWorkforce();

  const rows = useMemo(
    () => rosterRows(employees.data ?? [], live.data ?? [], sort),
    [employees.data, live.data, sort],
  );

  function select(next: Partial<{ profileId: string; date: string }>) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) query.set(key, value);
    // `replace`, not `push`: clicking through eight people should not leave eight
    // entries for the back button to walk out of.
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  const selected = rows.find((row) => row.profileId === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-7">
      <PageHeader
        title="Activity"
        subtitle="Pick someone to read their day without leaving the list."
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
          onSelect={(profileId) => select({ profileId })}
        />

        {selectedId ? (
          <Detail profileId={selectedId} person={selected} dateKey={dateKey} />
        ) : (
          <NothingSelected hasPeople={rows.length > 0} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Day navigation                                                              */
/* -------------------------------------------------------------------------- */

function DayNav({ dateKey, onChange }: { dateKey: string; onChange: (date: string) => void }) {
  const today = dateKeyOf(new Date());
  const atToday = dateKey === today;

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(shiftDateKey(dateKey, -1))}
        aria-label="Previous day"
        className={stepClass}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>

      <input
        type="date"
        value={dateKey}
        max={today}
        onChange={(event) => {
          const next = event.target.value;
          if (next && !isFutureDateKey(next)) onChange(next);
        }}
        aria-label="Day"
        className="tabular h-9 rounded-md border bg-card px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <button
        type="button"
        onClick={() => onChange(shiftDateKey(dateKey, 1))}
        disabled={atToday}
        aria-label="Next day"
        className={stepClass}
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>

      {!atToday ? (
        <button type="button" onClick={() => onChange(today)} className={cn(stepClass, "w-auto px-2.5 text-xs")}>
          Today
        </button>
      ) : null}
    </div>
  );
}

const stepClass =
  "grid h-9 w-9 place-items-center rounded-md border bg-card text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:text-muted-foreground";

/* -------------------------------------------------------------------------- */
/* Master pane                                                                 */
/* -------------------------------------------------------------------------- */

function Roster({
  rows,
  selectedId,
  sort,
  onSort,
  loading,
  error,
  onSelect,
}: {
  rows: RosterRow[];
  selectedId: string | null;
  sort: RosterSort;
  onSort: (sort: RosterSort) => void;
  loading: boolean;
  error: string | null;
  onSelect: (profileId: string) => void;
}) {
  return (
    <section aria-label="Roster" className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {rows.length > 0 ? `${rows.length} people` : "People"}
        </h2>
        {/* Two sorts, deliberately. Cattr offers exactly these two and every extra
            one is a control a manager has to read past. */}
        <div className="flex items-center gap-0.5" role="group" aria-label="Sort roster">
          {(["activity", "name"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onSort(option)}
              aria-pressed={sort === option}
              className={cn(
                "rounded px-1.5 py-1 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

      {error ? (
        <p className="px-3 py-6 text-sm text-muted-foreground">{error}</p>
      ) : loading ? (
        <ul className="divide-y">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="px-3 py-2.5">
              <span className="block h-4 w-32 animate-pulse rounded bg-muted" />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <div className="px-3 py-8 text-center">
          <p className="text-sm font-medium">No one to show yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            People appear here once they are added to your company.
          </p>
        </div>
      ) : (
        <ul className="max-h-[70vh] divide-y overflow-y-auto">
          {rows.map((row) => {
            const active = row.profileId === selectedId;

            return (
              <li key={row.profileId}>
                <button
                  type="button"
                  onClick={() => onSelect(row.profileId)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "w-full px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    active ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{row.name}</span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {relativeTime(row.lastSeenAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <StatusDot status={row.status} className="text-xs text-muted-foreground" />
                    <span className="truncate text-xs text-muted-foreground">
                      {row.monitoringEnabled ? (row.deviceLabel ?? row.department ?? "") : "Monitoring paused"}
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
}: {
  profileId: string;
  person: RosterRow | null;
  dateKey: string;
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

  // `tick` is the dependency that matters here: it is the clock, and dropping it
  // would freeze today's window at the moment the screen first rendered.
  const range = useMemo(() => dayWindow(dateKey), [dateKey, tick]);

  const { data, isLoading, isError, error, refetch } = useDayTimeline(profileId, range.from, range.to);

  return (
    <section aria-label="Day detail" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-tight">
            {person?.name ?? "Selected person"}
          </h2>
          <p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
            {person ? <StatusDot status={person.status} className="text-sm" /> : null}
            {person?.department ? <span>{person.department}</span> : null}
          </p>
        </div>

        {/* The same day, on the full employee page. Their timeline tab reads `date`
            and treats its absence as today, so today omits it rather than pinning a
            key that goes stale the moment the clock rolls over. */}
        <Link
          href={`/people/${profileId}/timeline${today ? "" : `?date=${dateKey}`}`}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    <section
      aria-label="Day detail"
      className="grid min-h-[18rem] place-items-center rounded-lg border bg-card px-6 py-10 text-center"
    >
      <div className="max-w-sm">
        <p className="text-sm font-medium">
          {hasPeople ? "Select someone to read their day" : "Nothing to read yet"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasPeople
            ? "Their timeline opens here — the list stays where it is, and the link in your address bar carries the selection."
            : "Once an agent reports its first session, the day appears here."}
        </p>
      </div>
    </section>
  );
}

function ActivitySkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-7">
      <div className="mb-6 h-7 w-32 animate-pulse rounded bg-muted" />
      <div className="grid gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <div className="h-72 animate-pulse rounded-lg border bg-card" />
        <div className="h-72 animate-pulse rounded-lg border bg-card" />
      </div>
    </div>
  );
}
