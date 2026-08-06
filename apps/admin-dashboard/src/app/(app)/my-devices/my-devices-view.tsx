"use client";

import { Badge, Button, cn } from "@aems/ui";
import { useQuery } from "@tanstack/react-query";
import { Check, Info, Laptop, Minus, ShieldCheck, Smartphone } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Fact, FactList, MePanel, MeShell } from "@/components/me/me-shell";
import {
  collectionStatus,
  consentForDevice,
  consentIsBehindPolicy,
  consentKey,
  readOwnConsent,
  type CollectionStatus,
  type ConsentState,
} from "@/components/me/consent";
import { longDate, longDateTime } from "@/components/me/account-model";
import {
  deviceReporting,
  deviceTitle,
  ownDevices,
  reportingCopy,
} from "@/components/me/device-list";
import {
  MONITORING_PROMISES,
  WHY_THIS_EXISTS,
  capturesPerWorkingDay,
  collectedItems,
  idleCadence,
  platformLabel,
  screenshotCadence,
  toPolicyTerms,
  type PolicyTerms,
} from "@/components/me/monitoring-terms";
import { WithdrawConsentDialog } from "@/components/me/withdraw-consent";
import {
  EmptyState,
  ErrorState,
  PanelSkeleton,
  SkeletonBar,
  StaleNotice,
} from "@/components/states";
import { describeError, useApiQuery, useSession } from "@/lib/api";
import { currentPolicyQuery, myDevicesQuery, type MyDeviceRow } from "@/lib/queries/account";
import { createClient } from "@/lib/supabase";

/**
 * "My devices" — which machines report under your name, what each one records, the
 * terms you are monitored under, and the way out.
 *
 * The last of those is the reason this screen exists rather than being a section of
 * /me. `POST /api/auth/consent/:deviceId/revoke` had no caller anywhere in the product,
 * so non-negotiables 1 and 4 described a right nobody could exercise. Everything else
 * here is the context a person needs before deciding to use it.
 *
 * Devices, the policy and the consent records are all warmed by `page.tsx`, so the
 * first paint carries real content rather than a skeleton that swaps.
 */
export function MyDevicesView() {
  const { data: session } = useSession();
  const profileId = session?.profileId ?? null;

  const devices = useApiQuery(myDevicesQuery);
  const policy = useApiQuery(currentPolicyQuery);

  /**
   * Consent, read straight from Supabase under this person's own JWT.
   *
   * The API has no endpoint that returns consent records — only one that revokes them —
   * and `consent_records_select_self` (RLS) is written for exactly this reader. The
   * `/devices` inventory reads `device_telemetry` the same way and for the same reason.
   * When `GET /api/auth/consent` exists this should move behind it.
   */
  const consent = useQuery({
    queryKey: consentKey(profileId ?? ""),
    queryFn: () => readOwnConsent(createClient(), profileId ?? ""),
    enabled: profileId !== null,
    staleTime: 60_000,
    retry: false,
  });

  const mine = ownDevices(devices.data, profileId);
  const terms = toPolicyTerms(policy.data);

  const status = collectionStatus(mine, consent.data, session?.monitoringEnabled ?? true);
  const reportingNow = mine.filter(
    (device) => deviceReporting(device, Date.now()) === "reporting",
  ).length;

  return (
    <MeShell
      title="My devices"
      subtitle="The devices enrolled under your name, and the terms they collect under."
    >
      {/*
       * The answer first, then the evidence.
       *
       * This page used to open with three paragraphs about why monitoring exists, and a
       * reader had to assemble "is anything running on me right now" out of a policy
       * panel and however many device cards. That question is the one they came for, so
       * it is answered in a sentence before anything else — and the essay it displaces
       * is still on the page, at the foot, where a thing read once in a career belongs.
       *
       * Absent entirely when the device read failed, rather than reduced to dashes: a
       * block whose whole job is to state what is being collected has nothing to say
       * when it does not know, and the error below says it properly.
       */}
      {devices.isError ? null : (
        <CollectionVerdict
          status={status}
          terms={terms}
          reportingNow={reportingNow}
          loading={devices.isLoading}
        />
      )}

      {devices.isError ? (
        <ErrorState
          title="Your devices could not be loaded"
          message={describeError(devices.error)}
          onRetry={() => void devices.refetch()}
        />
      ) : devices.isLoading ? (
        <PanelSkeleton minHeightClass="min-h-[18rem]" lines={4} label="Loading your devices" />
      ) : mine.length === 0 ? (
        <EmptyState
          title="No devices are enrolled under your name"
          body="Nothing is being collected about you. When you are given a company laptop or phone, the AEMS agent on it asks for a sign-in code — your administrator issues one — and the device then appears here."
        />
      ) : (
        <>
          {/* Consent is a second source. Its failing costs the consent block on each
              card, not the page, so it is said out loud and the rest stays up. */}
          {consent.isError ? (
            <StaleNotice
              className="rounded-md border"
              message="Your consent records could not be read, so this page cannot show which devices you have agreed to. Everything else is current."
              onRetry={() => void consent.refetch()}
            />
          ) : null}

          <h2 className="pt-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {mine.length === 1 ? "Your device" : `Your ${String(mine.length)} devices`}
          </h2>

          {mine.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              terms={terms}
              profileId={profileId ?? ""}
              consent={consentForDevice(consent.data, device.id)}
              consentKnown={consent.data !== undefined}
            />
          ))}
        </>
      )}

      <PolicyPanel
        terms={terms}
        publishedAt={policy.data?.created_at ?? null}
        isLoading={policy.isLoading}
        isError={policy.isError}
        error={policy.error}
        onRetry={() => void policy.refetch()}
      />

      <HowThisWorks />
    </MeShell>
  );
}

/* -------------------------------------------------------------------------- */
/* The conclusion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * "Is anything being collected about me right now?", answered in one line.
 *
 * Drawn like `VerdictBlock` on the Overview because it does the same job for a different
 * reader — a sentence a person can act on, with the figures demoted underneath to
 * support it rather than to be decoded.
 *
 * Two rules this block must not break:
 *
 *  1. **Never claim "nothing" from a failed read.** `collectionStatus` returns
 *     `collecting: null` when the consent records could not be fetched, and that case
 *     gets its own sentence instead of borrowing the reassuring one.
 *  2. **Never spend the AI accent on it.** Indigo means model output; every state here
 *     is recorded fact, so it uses status tokens only.
 */
function CollectionVerdict({
  status,
  terms,
  reportingNow,
  loading,
}: {
  status: CollectionStatus;
  terms: PolicyTerms | null;
  reportingNow: number;
  loading: boolean;
}) {
  const headline = verdictHeadline(status);

  return (
    <section
      aria-label="What is being collected about you"
      className="rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6"
    >
      {loading ? (
        // Same block, same height, so the real reading lands where the placeholder was.
        <>
          <SkeletonBar className="h-8 w-56 max-w-full" />
          <SkeletonBar className="mt-3 h-4 w-4/5 max-w-lg" />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="tabular text-2xl font-semibold tracking-[-0.025em] sm:text-[26px]">
              {headline.title}
            </h2>
            <Badge variant={headline.variant} dot>
              {headline.badge}
            </Badge>
          </div>

          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            {headline.body}
            {status.collecting !== null && status.collecting > 0 && terms
              ? ` The terms are ${terms.name}, version ${terms.version}.`
              : ""}
          </p>
        </>
      )}

      <dl className="mt-5 flex flex-wrap gap-x-7 gap-y-3 border-t pt-4">
        {[
          { label: "Devices enrolled", value: String(status.enrolled) },
          // An em dash, never a zero: "Collecting now 0" is a claim, and a failed
          // consent read is not entitled to make it.
          {
            label: "Collecting now",
            value: status.collecting === null ? "—" : String(status.collecting),
          },
          { label: "Reporting in", value: String(reportingNow) },
          { label: "Policy version", value: terms?.version ?? "—" },
        ].map((figure) => (
          <div key={figure.label}>
            <dd className="tabular text-base font-semibold tracking-[-0.02em] sm:text-[17px]">
              {loading ? <SkeletonBar className="h-5 w-14" /> : figure.value}
            </dd>
            <dt className="text-[11px] text-muted-foreground">{figure.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The sentence, chosen by state.
 *
 * Kept beside the block rather than in `consent.ts` because it is copy for one screen,
 * and the judgement it reads — `collectionStatus` — is already pure and asserted there.
 */
function verdictHeadline(status: CollectionStatus): {
  title: string;
  badge: string;
  variant: "success" | "warning" | "secondary";
  body: string;
} {
  if (status.accountPaused) {
    return {
      title: "Nothing is being collected",
      badge: "Paused",
      variant: "secondary",
      // No device count in the sentence: it holds at zero devices as well as at five,
      // and the count is a figure below rather than something to conjugate here.
      body: "Your administrator has paused monitoring for your account, so no device of yours may send anything. Activity recorded before it was paused is still kept, and only an administrator can resume it.",
    };
  }

  if (status.collecting === null) {
    return {
      title: "Cannot confirm right now",
      badge: "Unknown",
      variant: "warning",
      // No "retry above": the retry lives on the notice further down the page, and a
      // sentence that points at the wrong control is worse than one that points at none.
      body: "Your consent records could not be read, so this page will not tell you either way. Until it can, treat every device below as still collecting.",
    };
  }

  if (status.enrolled === 0) {
    return {
      title: "Nothing is being collected",
      badge: "No devices",
      variant: "secondary",
      body: "No device is enrolled under your name, so there is nothing for the agent to run on and nothing to record.",
    };
  }

  if (status.collecting === 0) {
    return {
      title: "Nothing is being collected",
      // Not "Consent withdrawn": the same zero is produced by a device an administrator
      // revoked and by one that was never agreed to, and naming the wrong cause on a
      // compliance screen is its own defect.
      badge: "Not collecting",
      variant: "secondary",
      body: `None of your ${String(status.enrolled)} enrolled ${status.enrolled === 1 ? "device" : "devices"} may collect anything — each one has either been revoked by an administrator or has no agreement from you on file. Everything already recorded is kept.`,
    };
  }

  return {
    title:
      status.collecting === status.enrolled && status.enrolled === 1
        ? "One device is collecting"
        : `${String(status.collecting)} of ${String(status.enrolled)} devices collecting`,
    badge: "Consent given",
    variant: "success",
    body: "You agreed to this on each device, and you can withdraw that agreement below at any time — collection stops within a minute of you doing so.",
  };
}

/* -------------------------------------------------------------------------- */
/* The explanation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why any of this exists at all.
 *
 * `docs/design.md` is explicit that the product is not framed as surveillance, so this
 * is not decoration — it is the difference between a policy notice and an explanation,
 * and the three promises are non-negotiables 1, 2 and 3 said out loud.
 *
 * It used to open the page. It closes it now: a reader arrives asking whether anything
 * is running on them today, which the verdict at the top answers, and the standing
 * argument for the product is what they read once and then never again. Nothing was
 * removed in the move.
 */
function HowThisWorks() {
  return (
    <MePanel title="How monitoring works here">
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {WHY_THIS_EXISTS}
      </p>

      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {MONITORING_PROMISES.map((promise) => (
          <li key={promise.title} className="rounded-md border bg-secondary/30 px-3 py-2.5">
            <p className="flex items-start gap-1.5 text-sm font-medium">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              {promise.title}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{promise.detail}</p>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-muted-foreground">
        <Link
          href="/me"
          className="rounded font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open My activity
        </Link>{" "}
        to read what has actually been recorded.
      </p>
    </MePanel>
  );
}

/* -------------------------------------------------------------------------- */
/* The policy                                                                  */
/* -------------------------------------------------------------------------- */

function PolicyPanel({
  terms,
  publishedAt,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  terms: PolicyTerms | null;
  publishedAt: string | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (isLoading) return <PanelSkeleton minHeightClass="min-h-[12rem]" lines={3} label="Loading the monitoring policy" />;

  if (isError) {
    // With a retry, not without one. The terms a person is monitored under are not
    // something to leave behind a dead end because one request timed out.
    return (
      <ErrorState
        title="The monitoring policy could not be loaded"
        message={describeError(error)}
        onRetry={onRetry}
      />
    );
  }

  if (!terms) {
    return (
      <MePanel title="The terms you are monitored under">
        <p className="text-sm text-muted-foreground">
          Your company has not published a monitoring policy yet. Until it does, no device
          can be enrolled and nothing can be collected.
        </p>
      </MePanel>
    );
  }

  const captures = capturesPerWorkingDay(terms);

  return (
    <MePanel
      title="The terms you are monitored under"
      description="Set by your company. Every enrolled device follows the version it was given."
      action={
        <Badge variant="outline" className="tabular shrink-0 font-normal">
          Version {terms.version}
        </Badge>
      }
    >
      <FactList>
        <Fact label="Policy">{terms.name}</Fact>
        <Fact label="Published">{longDate(publishedAt)}</Fact>
        <Fact
          label="Screenshots"
          hint={captures > 0 ? `About ${String(captures)} in an eight-hour day.` : undefined}
        >
          Taken {screenshotCadence(terms)}
        </Fact>
        <Fact
          label="Counted as idle"
          hint="Idle time is measured from whether input happened, never from what was typed."
        >
          After no keyboard or mouse activity {idleCadence(terms)}
        </Fact>
        {terms.trackedCategories.length > 0 ? (
          <Fact label="Activity grouped as">
            <span className="flex flex-wrap gap-1.5">
              {terms.trackedCategories.map((category) => (
                <Badge key={category} variant="secondary" className="font-normal">
                  {category}
                </Badge>
              ))}
            </span>
          </Fact>
        ) : null}
      </FactList>
    </MePanel>
  );
}

/* -------------------------------------------------------------------------- */
/* One device                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `reportingCopy`'s tone, as a badge variant.
 *
 * The tone stays the vocabulary of `device-list.ts` — it is decided by meaning there and
 * tested there — and this table is the only place it becomes a colour.
 */
const REPORTING_VARIANT = {
  success: "success",
  warning: "warning",
  muted: "secondary",
} as const;

function DeviceCard({
  device,
  terms,
  profileId,
  consent,
  consentKnown,
}: {
  device: MyDeviceRow;
  terms: PolicyTerms | null;
  profileId: string;
  consent: ConsentState;
  consentKnown: boolean;
}) {
  const [withdrawing, setWithdrawing] = useState(false);

  const title = deviceTitle(device);
  const reporting = reportingCopy(deviceReporting(device, Date.now()));
  const Icon = device.platform === "android" ? Smartphone : Laptop;
  const items = collectedItems(device.platform, terms);

  return (
    <MePanel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-secondary/50">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight" title={title}>
              {title}
            </h2>
            {/* `break-words`: a Windows machine name and an agent build number run to
                one long token, and at 390px an unbreakable one pushes the card wider
                than the viewport. */}
            <p className="mt-0.5 break-words text-xs text-muted-foreground">
              {platformLabel(device.platform)}
              {device.os_version ? ` ${device.os_version}` : ""}
              {device.model ? ` · ${device.model}` : ""}
              {device.agent_version ? ` · agent ${device.agent_version}` : ""}
            </p>
          </div>
        </div>

        {/* The shared pill rather than a hand-drawn dot: "Reporting" is a state, and the
            `dot` prop is how this product distinguishes a state from a label. */}
        <Badge variant={REPORTING_VARIANT[reporting.tone]} dot className="shrink-0">
          {reporting.label}
        </Badge>
      </div>

      {reporting.detail ? (
        <p className="mt-2 text-xs text-muted-foreground">{reporting.detail}</p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <FactList>
          <Fact label="Last reported">
            <RelativeTime iso={device.last_seen_at} />
          </Fact>
          <Fact label="Enrolled">{longDate(device.enrolled_at)}</Fact>
        </FactList>
        <FactList>
          {device.cpu ? (
            <Fact label="Processor">
              <span className="break-words">{device.cpu}</span>
            </Fact>
          ) : null}
          {device.ram_mb ? (
            <Fact label="Memory">
              <span className="tabular">{`${String(Math.round(device.ram_mb / 1024))} GB`}</span>
            </Fact>
          ) : null}
        </FactList>
      </div>

      <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        What this device records
      </h3>
      <ul className="mt-2 grid gap-2.5 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.title} className="flex items-start gap-2">
            {item.absent ? (
              <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0">
              <span
                className={cn(
                  "block text-sm font-medium",
                  item.absent && "text-muted-foreground",
                )}
              >
                {item.title}
              </span>
              <span className="block text-xs leading-relaxed text-muted-foreground">
                {item.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <ConsentBlock
        consent={consent}
        consentKnown={consentKnown}
        currentVersion={terms?.version ?? null}
        onWithdraw={() => setWithdrawing(true)}
      />

      {withdrawing ? (
        <WithdrawConsentDialog
          deviceId={device.id}
          deviceTitle={title}
          platform={device.platform}
          profileId={profileId}
          onClose={() => setWithdrawing(false)}
        />
      ) : null}
    </MePanel>
  );
}

/**
 * The agreement on file for this device, and the button that ends it.
 *
 * Three states, and the third is the one worth having: a device with no consent record
 * at all is a device that may not legally be collected from, and saying so is more
 * reassuring than silence — the reader can check it against whether they remember
 * accepting anything.
 */
function ConsentBlock({
  consent,
  consentKnown,
  currentVersion,
  onWithdraw,
}: {
  consent: ConsentState;
  consentKnown: boolean;
  currentVersion: string | null;
  onWithdraw: () => void;
}) {
  if (!consentKnown) {
    return (
      <div className="mt-5 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          Your agreement for this device could not be read just now.
        </p>
      </div>
    );
  }

  if (consent.state === "none") {
    return (
      <div className="mt-5 border-t pt-4">
        <p className="text-sm">
          <span className="font-medium">No agreement on file.</span>{" "}
          <span className="text-muted-foreground">
            Nothing may be collected from this device until you accept the policy on it.
          </span>
        </p>
      </div>
    );
  }

  if (consent.state === "withdrawn") {
    return (
      <div className="mt-5 border-t pt-4">
        <p className="text-sm">
          <span className="font-medium">You withdrew your consent</span>{" "}
          <span className="text-muted-foreground">
            on {longDateTime(consent.revokedAt)}. Nothing is being collected from this device. To
            allow it again, accept the policy in the AEMS agent on the device itself.
          </span>
        </p>
      </div>
    );
  }

  const behind = consentIsBehindPolicy(consent, currentVersion);

  return (
    <div className="mt-5 flex flex-wrap items-end justify-between gap-3 border-t pt-4">
      <div className="min-w-0">
        <p className="text-sm">
          <span className="font-medium">
            You accepted version <span className="tabular">{consent.policyVersion}</span>
          </span>{" "}
          <span className="text-muted-foreground">on {longDateTime(consent.consentedAt)}.</span>
        </p>
        {behind ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              Your company has since published version{" "}
              <span className="tabular">{currentVersion}</span>. The terms shown above are that
              newer version.
            </span>
          </p>
        ) : null}
      </div>

      {/* Full width on a phone. This is the control that makes non-negotiable #4 real,
          and it must not end up as a 130px target wedged beside wrapped text. */}
      <Button
        type="button"
        variant="outline"
        onClick={onWithdraw}
        className="w-full shrink-0 sm:w-auto"
      >
        Withdraw consent
      </Button>
    </div>
  );
}
