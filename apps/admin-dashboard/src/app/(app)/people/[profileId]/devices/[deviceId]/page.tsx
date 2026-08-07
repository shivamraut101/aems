"use client";

import { Badge } from "@aems/ui";
import { ArrowLeft, Laptop, Smartphone } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { ActivityTimeline, TimelineSkeleton } from "@/components/activity-timeline";
import { devicesQuery } from "@/components/employee/employee-queries";
import { PhoneDay } from "@/components/employee/phone-day";
import { SectionHeading } from "@/components/employee/states";
import { useDeviceTelemetry } from "../device-queries";
import { useDayWindow } from "@/components/employee/use-day-window";
import { clampWindowToNow } from "@/components/timeline/model";
import { RelativeTime } from "@/components/relative-time";
import { useApiQuery, type DeviceRow } from "@/lib/api";
import { useDayTimeline } from "@/lib/queries/timeline";
import { devicesForProfile, osLabel } from "@/lib/queries/usage";

import { dayHref } from "@/components/employee/tabs";

/** Matches the Timeline tab: the signed screenshot URLs inside expire in ten minutes. */
const CLOCK_INTERVAL_MS = 5 * 60_000;

/**
 * One machine, one day.
 *
 * The seven tabs above answer questions about a *person*, which is right — a laptop
 * and a phone reporting at the same moment are unioned rather than added, so the day
 * never exceeds the clock. But that left no way to ask about a machine: an employee
 * with a laptop and two phones produced one merged stream, so "what did the field
 * phone do on Tuesday" had no answer, and neither did "this device went quiet — what
 * was it doing before it did".
 *
 * Everything here is the same reduction the person-level timeline uses, narrowed by
 * `?deviceId=`. Deliberately not a second computation: a device day and a person day
 * that disagreed about the same hours would be worse than not having this page.
 *
 * The day comes from the shared `DayRangeControl` in the page chrome, so stepping
 * between dates works here exactly as it does on every other tab, and the URL carries
 * both the machine and the date — which is what makes this view sendable to somebody.
 */
export default function DeviceDayPage() {
  return (
    <Suspense fallback={<TimelineSkeleton />}>
      <DeviceDay />
    </Suspense>
  );
}

function DeviceDay() {
  const params = useParams();
  const search = useSearchParams();
  const profileId = typeof params?.["profileId"] === "string" ? params["profileId"] : "";
  const deviceId = typeof params?.["deviceId"] === "string" ? params["deviceId"] : "";

  const day = useDayWindow();

  // Same reason as the Timeline tab: reading the clock during render would mint a new
  // query key every render, and the server's clock is not the reader's.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const devices = useApiQuery(devicesQuery);
  const device = useMemo<DeviceRow | null>(
    () => devicesForProfile(devices.data ?? [], profileId).find((d) => d.id === deviceId) ?? null,
    [devices.data, profileId, deviceId],
  );

  const window = day && now ? clampWindowToNow({ from: day.from, to: day.to }, now) : null;
  const notStarted = window !== null && window.from === window.to;

  const query = useDayTimeline(
    profileId,
    window?.from ?? "",
    window?.to ?? "",
    undefined,
    deviceId,
  );

  const isPhone = device?.platform === "android";
  const Icon = isPhone ? Smartphone : Laptop;
  const name = device ? device.device_name || device.label : "This device";

  // Battery, network and screen-on time. Only phones send them, and the phone view
  // leads with them — they are what a handset can answer about a working day.
  const telemetry = useDeviceTelemetry(deviceId, isPhone === true);

  return (
    <div>
      {/* Back to the list rather than to the person: somebody who drilled into one
          machine is comparing machines, and the browser's Back is not a promise this
          page can make when the date control rewrites the URL. `dayHref` carries the
          date so returning does not throw them back to today. */}
      <Link
        href={dayHref(`/people/${profileId}/devices`, search.toString(), search.get("date"))}
        className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        All devices
      </Link>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold">{name}</h2>
        {device ? (
          <>
            <span className="text-xs text-muted-foreground">
              {osLabel(device.platform, device.os_version)}
            </span>
            {device.is_primary ? (
              // Said here because it changes what the numbers below mean: on this
              // person's other screens, the day is computed from this machine.
              <Badge variant="secondary">Primary · defines working hours</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              Last heartbeat <RelativeTime iso={device.last_seen_at} />
            </span>
          </>
        ) : null}
      </div>

      <SectionHeading
        title={day ? `Activity on ${day.label}` : "Activity"}
        hint={
          device?.platform === "android"
            ? "Everything this phone recorded. Phones do not capture screenshots, window titles or websites."
            : "Everything this machine recorded — applications, idle stretches, breaks and screenshots."
        }
      />

      {day === null || window === null ? (
        <TimelineSkeleton />
      ) : isPhone ? (
        /* A phone gets a phone's numbers. Rendering ActivityTimeline here asked it the
           desktop's questions and answered with structural zeroes — every enrolled
           handset has idle_events 0, break_events 0, screenshots 0, because Android
           exposes no idle signal and this app captures no screen. See `PhoneDay`. */
        <PhoneDay
          apps={notStarted ? [] : (query.data?.topApps ?? [])}
          latest={telemetry.data?.latest ?? null}
          telemetryPending={telemetry.isPending}
          isLoading={query.isPending && query.fetchStatus === "fetching"}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          dayLabel={day.label}
        />
      ) : (
        <ActivityTimeline
          timeline={notStarted ? null : query.data}
          isLoading={query.isPending && query.fetchStatus === "fetching"}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          emptyHint={
            notStarted
              ? `${day.label} has not started yet.`
              : `${name} reported nothing on ${day.label}. Use the date control above to look at another day.`
          }
        />
      )}
    </div>
  );
}
