"use client";

import { ArrowRight, EyeOff, Laptop } from "lucide-react";
import Link from "next/link";

import { DayRangeControl } from "@/components/employee/day-range-control";
import { OverviewTab } from "@/components/employee/overview-tab";
import { ErrorState, PanelSkeleton } from "@/components/states";
import { useDayWindow } from "@/components/employee/use-day-window";
import { useApiQuery, useSession } from "@/lib/api";
import { currentPolicyQuery } from "@/lib/queries/account";

import { MePanel, MeShell } from "./me-shell";
import { capturesPerWorkingDay, idleCadence, screenshotCadence, toPolicyTerms } from "./monitoring-terms";
import { resolveSelfSubject, selfGreeting } from "./self-subject";

/**
 * "My activity" — the destination every role keeps, and where an employee lands after
 * signing in (`landingPathForRole`).
 *
 * Non-negotiable #3 says employees can read their own data, and it is enforced in RLS
 * and in the API (`/api/analytics/timeline` is `requireUser` and 403s only when an
 * employee asks about somebody else). This screen is what makes the promise visible.
 *
 * It reuses the manager Overview rather than reimplementing it, so the figures an
 * employee reads about themselves are computed by exactly the same code and cannot
 * quietly disagree with what their manager is shown.
 *
 * Landing here and finding one page was the client's complaint. The rest of the
 * section — My devices, Account — is in the sidebar's `personal` group; the terms panel
 * at the foot is the short answer to "what is being collected", with the full answer
 * one link away.
 */
export function MyActivity() {
  const { data: session, isLoading, isError } = useSession();
  const day = useDayWindow();
  const subject = resolveSelfSubject({ session: session ?? null, isLoading, isError });

  if (subject.state === "error") {
    return (
      <MeShell title="My activity" subtitle="Everything recorded about your work.">
        {/* The message named the way out and gave no way to take it. `ErrorState` offers
            a retry, which is the wrong control for a session that has expired — another
            round trip is spent being refused identically — so the link sits beside it. */}
        <ErrorState
          title="Could not load your account"
          message="We could not confirm who is signed in. Sign in again to continue."
        />
        <Link
          href="/login"
          className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Sign in
        </Link>
      </MeShell>
    );
  }

  if (subject.state === "signed-out") {
    return (
      <MeShell title="My activity" subtitle="Everything recorded about your work.">
        <MePanel>
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
        </MePanel>
      </MeShell>
    );
  }

  const heading =
    subject.state === "ready" ? `Good day, ${selfGreeting(subject.fullName)}` : "My activity";

  return (
    <MeShell
      title={heading}
      subtitle={day ? day.label : "Everything recorded about your work, as your manager sees it."}
      control={day ? <DayRangeControl day={day} /> : null}
    >
      {/* Stated before the data, not after: on a paused account the day is empty for a
          reason, and an unexplained blank screen reads as a broken agent. */}
      {subject.state === "ready" && !subject.monitoringEnabled ? <MonitoringPaused /> : null}

      {subject.state === "ready" ? (
        /* appsHref={null}: an employee cannot reach /people/:id/apps, so no link. */
        <OverviewTab profileId={subject.profileId} appsHref={null} />
      ) : (
        /* Only reachable when the cache has no session at all — the root layout seeds
           it on every ordinary render, so this is the cold-start case, not the norm. */
        <PanelSkeleton minHeightClass="min-h-[20rem]" lines={4} label="Loading your day" />
      )}

      <MonitoringSummary />
    </MeShell>
  );
}

function MonitoringPaused() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 text-sm">
        <span className="font-medium">Monitoring is paused for your account.</span>{" "}
        <span className="text-muted-foreground">
          Nothing new is being collected on any of your devices. Activity recorded before it was
          paused is still shown here, and only your administrator can resume it.
        </span>{" "}
        <Link
          href="/my-devices"
          className="rounded font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          See your devices
        </Link>
      </p>
    </div>
  );
}

/**
 * The terms, in one line, at the foot of the day they produced.
 *
 * Server-prefetched by `page.tsx`, so it is part of the first paint rather than a panel
 * that appears a beat later. It is deliberately a summary and not the whole policy:
 * this page is about what was recorded, and the page about *why* is one link away.
 */
function MonitoringSummary() {
  const policy = useApiQuery(currentPolicyQuery);
  const terms = toPolicyTerms(policy.data);
  const captures = capturesPerWorkingDay(terms);

  return (
    <MePanel title="What is being collected">
      {terms ? (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          Under <span className="font-medium text-foreground">{terms.name}</span> (version{" "}
          <span className="tabular">{terms.version}</span>), your enrolled devices record the
          applications you use, take a screenshot {screenshotCadence(terms)}
          {captures > 0 ? ` — about ${String(captures)} in an eight-hour day` : ""}, and count you
          idle after no keyboard or mouse activity {idleCadence(terms)}. What you type is never
          recorded.
        </p>
      ) : (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          Your devices record the applications you use, screenshots at a set interval, and idle
          periods. What you type is never recorded.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href="/my-devices"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Laptop className="h-3.5 w-3.5" aria-hidden />
          My devices and consent
        </Link>
        <Link
          href="/account"
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Account
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </MePanel>
  );
}
