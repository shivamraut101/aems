"use client";

import { Badge, Button, cn } from "@aems/ui";
import { useQuery } from "@tanstack/react-query";
import { Check, Info, Laptop, Minus, ShieldCheck, Smartphone } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Fact, FactList, MePanel, MeShell } from "@/components/me/me-shell";
import {
  consentForDevice,
  consentIsBehindPolicy,
  consentKey,
  readOwnConsent,
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
import { EmptyState, ErrorState, PanelSkeleton, StaleNotice } from "@/components/states";
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

  return (
    <MeShell
      title="My devices"
      subtitle="The devices enrolled under your name, and the terms they collect under."
    >
      <HowThisWorks />

      <PolicyPanel
        terms={terms}
        publishedAt={policy.data?.created_at ?? null}
        isLoading={policy.isLoading}
        isError={policy.isError}
        error={policy.error}
      />

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
    </MeShell>
  );
}

/* -------------------------------------------------------------------------- */
/* The explanation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why any of this exists, before what it does.
 *
 * `docs/design.md` is explicit that the product is not framed as surveillance, and an
 * employee's first question is never "what is the screenshot interval" — it is "why is
 * this on my laptop". Answering that first is the difference between a policy notice
 * and an explanation.
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
}: {
  terms: PolicyTerms | null;
  publishedAt: string | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}) {
  if (isLoading) return <PanelSkeleton minHeightClass="min-h-[12rem]" lines={3} label="Loading the monitoring policy" />;

  if (isError) {
    return (
      <ErrorState
        title="The monitoring policy could not be loaded"
        message={describeError(error)}
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
        <Badge variant="outline" className="shrink-0 font-normal">
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
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {platformLabel(device.platform)}
              {device.os_version ? ` ${device.os_version}` : ""}
              {device.model ? ` · ${device.model}` : ""}
              {device.agent_version ? ` · agent ${device.agent_version}` : ""}
            </p>
          </div>
        </div>

        <span className="flex shrink-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 rounded-full",
              reporting.tone === "success" && "bg-success",
              reporting.tone === "warning" && "bg-warning",
              reporting.tone === "muted" && "bg-muted-foreground/50",
            )}
          />
          <span className="text-xs font-medium">{reporting.label}</span>
        </span>
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
          {device.cpu ? <Fact label="Processor">{device.cpu}</Fact> : null}
          {device.ram_mb ? (
            <Fact label="Memory">{`${String(Math.round(device.ram_mb / 1024))} GB`}</Fact>
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
          <span className="font-medium">You accepted version {consent.policyVersion}</span>{" "}
          <span className="text-muted-foreground">on {longDateTime(consent.consentedAt)}.</span>
        </p>
        {behind ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              Your company has since published version {currentVersion}. The terms shown above are
              that newer version.
            </span>
          </p>
        ) : null}
      </div>

      <Button type="button" variant="outline" onClick={onWithdraw} className="shrink-0">
        Withdraw consent
      </Button>
    </div>
  );
}
