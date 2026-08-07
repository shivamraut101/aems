"use client";

import { BatteryCharging, Battery, Signal, Smartphone, Wifi, WifiOff } from "lucide-react";

import { EmptyState, ErrorState } from "@/components/states";
import type { DeviceTelemetryRow } from "@/app/(app)/people/[profileId]/devices/device-queries";
import { duration as formatDuration } from "@/lib/format";
import type { AppUsage } from "@aems/types";

/**
 * A phone's day, measured in what a phone actually reports.
 *
 * The device page first rendered `ActivityTimeline` here, which was wrong and looked
 * wrong: it asked a phone the desktop's questions and answered them with structural
 * zeroes. Confirmed across every enrolled handset — `idle_events 0`, `break_events 0`,
 * `screenshots 0`. Those are not gaps waiting to fill; Android exposes no
 * keyboard/mouse idle signal at all, and this app captures no screen. A KPI row
 * reading "Idle 0m · Break 0m" beside "No data 2h 16m" is three numbers that cannot
 * mean anything, and it buries the two that can.
 *
 * What a phone sends is app usage sessions, screen-on seconds, battery and network.
 * So those are the numbers, in that order — screen-on first, because it is the phone's
 * answer to "was this person working", and the app list below it because that is the
 * answer to "on what".
 */

const NETWORK_ICON = { wifi: Wifi, cellular: Signal, ethernet: Signal, offline: WifiOff } as const;
const NETWORK_LABEL = {
  wifi: "Wi-Fi",
  cellular: "Mobile data",
  ethernet: "Ethernet",
  offline: "No connection",
} as const;

/**
 * Screen-on seconds since local midnight, from the newest sample.
 *
 * Never a sum: the agent accumulates this and resets it at midnight, so the latest
 * row already *is* the day's figure (migration …0016 carries the same warning on the
 * column). Adding the samples would multiply the day by the sample count.
 */
function screenOnSeconds(latest: DeviceTelemetryRow | null): number | null {
  return latest?.screen_active_seconds ?? null;
}

export function PhoneDay({
  apps,
  latest,
  telemetryPending,
  isLoading,
  isError,
  error,
  onRetry,
  dayLabel,
}: {
  apps: readonly AppUsage[];
  latest: DeviceTelemetryRow | null;
  telemetryPending: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  dayLabel: string;
}) {
  if (isError) {
    return (
      <ErrorState
        title="This day could not be loaded"
        message={error instanceof Error ? error.message : "Something went wrong."}
        onRetry={onRetry}
      />
    );
  }

  const screenOn = screenOnSeconds(latest);
  const ranked = [...apps].filter((a) => a.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  const busiest = ranked[0]?.seconds ?? 0;
  const totalAppSeconds = ranked.reduce((sum, a) => sum + a.seconds, 0);

  return (
    <div className="space-y-4">
      {/* Four readings, and each is one a phone can actually answer. No Idle, no Break,
          no Productive: Android reports none of them, and a zero is a claim. */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        <Kpi
          label="Screen on today"
          value={screenOn === null ? (telemetryPending ? "…" : "Not reported") : formatDuration(screenOn)}
          hint="Since midnight, from the phone itself"
        />
        <Kpi
          label="Apps used"
          value={isLoading ? "…" : String(ranked.length)}
          hint={ranked.length > 0 ? `${formatDuration(totalAppSeconds)} in the foreground` : "None recorded"}
        />
        <Kpi
          label="Battery"
          value={
            latest?.battery_level === null || latest?.battery_level === undefined
              ? telemetryPending
                ? "…"
                : "Not reported"
              : `${String(latest.battery_level)}%`
          }
          hint={latest?.battery_charging === true ? "Charging" : "On battery"}
          icon={latest?.battery_charging === true ? BatteryCharging : Battery}
        />
        <Kpi
          label="Network"
          value={
            latest?.network_type
              ? NETWORK_LABEL[latest.network_type]
              : telemetryPending
                ? "…"
                : "Not reported"
          }
          hint={
            latest?.storage_free_mb === null || latest?.storage_free_mb === undefined
              ? undefined
              : `${String(Math.round(latest.storage_free_mb / 1024))} GB free`
          }
          icon={latest?.network_type ? NETWORK_ICON[latest.network_type] : undefined}
        />
      </dl>

      <section className="rounded-lg border bg-card">
        <header className="border-b px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold">Apps used on {dayLabel}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Foreground time per app, longest first. Android reports which app was in
            front, never what was on the screen — no titles, no page addresses.
          </p>
        </header>

        {isLoading ? (
          <div className="space-y-2 p-4 sm:p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <span key={i} className="block h-6 w-full animate-pulse rounded bg-muted" aria-hidden />
            ))}
          </div>
        ) : ranked.length === 0 ? (
          <EmptyState
            title="No app usage recorded"
            // The commonest cause by far, and the one the reader can act on. Without
            // Usage Access the phone still heartbeats and still reports battery, so
            // "nothing here" looks like a quiet day rather than a missing permission.
            body={`This phone reported nothing for ${dayLabel}. If that looks wrong, check that Usage Access is granted to AEMS in the phone's settings — without it Android reports no app usage at all, while everything else keeps working.`}
          />
        ) : (
          <ul className="divide-y">
            {ranked.map((app) => (
              <li key={app.appName} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                <span className="min-w-0 flex-1 truncate" title={app.appName}>
                  {app.appName}
                </span>
                {/* A bar rather than a percentage: the question is which app dominated,
                    and a row of lengths answers it without anybody reading a number. */}
                <span
                  className="hidden h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
                  aria-hidden
                >
                  <i
                    className="block h-full rounded-full bg-[hsl(var(--success))]"
                    style={{ width: `${String(busiest > 0 ? (app.seconds / busiest) * 100 : 0)}%` }}
                  />
                </span>
                <span className="tabular w-16 shrink-0 text-right text-muted-foreground">
                  {formatDuration(app.seconds)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Phones report app usage, screen-on time and device readings. They do not
          capture screenshots, window titles or websites, and Android gives no
          keyboard-or-mouse idle signal — which is why there is no idle or break figure
          here rather than a zero.
        </span>
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular">{value}</dd>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
