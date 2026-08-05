"use client";

import { EyeOff } from "lucide-react";
import Link from "next/link";

import { DayRangeControl } from "@/components/employee/day-range-control";
import { OverviewTab } from "@/components/employee/overview-tab";
import { ErrorState, Panel, SkeletonLines } from "@/components/employee/states";
import { useDayWindow } from "@/components/employee/use-day-window";
import { useSession } from "@/lib/api";

import { resolveSelfSubject, selfGreeting } from "./self-subject";

/**
 * "My activity" — the one destination every role keeps.
 *
 * Non-negotiable #3 says employees can read their own data, and it is enforced in RLS
 * and in the API (`/api/analytics/timeline` is `requireUser` and 403s only when an
 * employee asks for somebody else). This screen is the surface that makes the promise
 * visible: without it, an employee signing in landed on `/me` and got a 404, which is
 * a transparency guarantee that exists only on paper.
 *
 * It reuses the manager Overview rather than reimplementing it, so the figures an
 * employee reads about themselves are computed by exactly the same code — and cannot
 * quietly disagree with what their manager is shown.
 */
export function MyActivity() {
  const { data: session, isLoading, isError } = useSession();
  const day = useDayWindow();
  const subject = resolveSelfSubject({ session: session ?? null, isLoading, isError });

  if (subject.state === "loading") return <MyActivitySkeleton />;

  if (subject.state === "error") {
    return (
      <Shell>
        <ErrorState
          title="Could not load your account"
          message="We could not confirm who is signed in. Sign in again to continue."
        />
      </Shell>
    );
  }

  if (subject.state === "signed-out") {
    return (
      <Shell>
        <Panel>
          <p className="text-sm text-muted-foreground">
            You are not signed in.{" "}
            <Link
              href="/login"
              className="rounded font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sign in
            </Link>{" "}
            to see your activity.
          </p>
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell
      heading={`Good day, ${selfGreeting(subject.fullName)}`}
      subheading={day ? day.label : null}
      control={day ? <DayRangeControl day={day} /> : null}
    >
      {/* Stated before the data, not after: on a paused account the day is empty for
          a reason, and an unexplained blank screen reads as a broken agent. */}
      {subject.monitoringEnabled ? null : <MonitoringPaused />}

      {/* appsHref={null}: an employee cannot reach /people/:id/apps, so no link. */}
      <OverviewTab profileId={subject.profileId} appsHref={null} />
    </Shell>
  );
}

function MonitoringPaused() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="text-sm">
        <span className="font-medium">Monitoring is paused for your account.</span>{" "}
        <span className="text-muted-foreground">
          Nothing new is being collected. Activity recorded before it was paused is still
          shown here.
        </span>
      </p>
    </div>
  );
}

function Shell({
  heading = "My activity",
  subheading,
  control,
  children,
}: {
  heading?: string;
  subheading?: string | null;
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{heading}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {subheading ?? "Everything recorded about your work, as your manager sees it."}
          </p>
        </div>
        {control}
      </div>

      <div className="space-y-6">{children}</div>
    </div>
  );
}

function MyActivitySkeleton() {
  return (
    <Shell>
      <Panel>
        <SkeletonLines count={4} />
      </Panel>
    </Shell>
  );
}
