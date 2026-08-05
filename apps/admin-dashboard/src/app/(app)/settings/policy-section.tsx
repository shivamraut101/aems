"use client";

import { describeError } from "@/lib/api";
import { useCompanyPolicy } from "@/lib/queries/settings";
import {
  SCREENSHOT_INTERVAL_OPTIONS,
  intervalLabel,
  policyState,
  screenshotsPerDay,
} from "@/lib/queries/settings-view";

import { DefinitionList, DefinitionRow, Notice, Section, ValueSkeleton } from "./section";

/**
 * The monitoring policy in force, read-only.
 *
 * Read-only is a statement of fact rather than a design choice: the API exposes the
 * policy on device enrolment and nowhere else, so there is no route to read one and
 * none to change one. What this panel *can* do honestly is show the agents' current
 * settings and say where they come from — an admin who cannot see the screenshot
 * interval cannot answer the one question every employee asks.
 *
 * A policy is versioned and consent is tied to a version (non-negotiable #1), so
 * editing one in place would silently invalidate the consent recorded against it.
 * Whatever writes this later has to publish a new version, not mutate this row.
 */
export function PolicySection() {
  const query = useCompanyPolicy();
  const state = policyState({
    isLoading: query.isLoading,
    error: query.error,
    data: query.data,
  });

  return (
    <Section
      title="Monitoring policy"
      description="What the desktop and Android agents are configured to collect. Agents pick up a change at their next check-in."
    >
      {state === "loading" ? (
        <DefinitionList>
          <DefinitionRow term="Policy version">
            <ValueSkeleton className="w-24" />
          </DefinitionRow>
          <DefinitionRow term="Screenshot interval">
            <ValueSkeleton className="w-20" />
          </DefinitionRow>
          <DefinitionRow term="Idle threshold">
            <ValueSkeleton className="w-20" />
          </DefinitionRow>
        </DefinitionList>
      ) : null}

      {state === "missing" ? (
        <Notice tone="warning" title="No monitoring policy has been published yet">
          <p>
            Devices cannot enrol until one exists — the agent is told to stop rather than
            guess an interval. Publish the first version through the API or a migration,
            then it appears here.
          </p>
        </Notice>
      ) : null}

      {state === "forbidden" ? (
        <Notice title="Only a super admin can read the monitoring policy">
          <p>Ask an administrator if you need the current screenshot interval.</p>
        </Notice>
      ) : null}

      {state === "error" ? (
        <Notice tone="error" title="Could not load the monitoring policy">
          <p>{describeError(query.error)}</p>
        </Notice>
      ) : null}

      {state === "ready" && query.data ? (
        <DefinitionList>
          <DefinitionRow term="Policy version" hint={query.data.name}>
            <span className="tabular font-medium">{query.data.version}</span>
          </DefinitionRow>

          <DefinitionRow
            term="Screenshot interval"
            hint={`About ${screenshotsPerDay(query.data.screenshot_interval_seconds)} captures over an eight-hour day.`}
          >
            <span className="tabular font-medium">
              {intervalLabel(query.data.screenshot_interval_seconds)}
            </span>
            {!SCREENSHOT_INTERVAL_OPTIONS.some(
              (option) => option.seconds === query.data?.screenshot_interval_seconds,
            ) ? (
              <span className="ml-2 text-xs text-muted-foreground">
                (outside the five standard intervals)
              </span>
            ) : null}
          </DefinitionRow>

          <DefinitionRow
            term="Idle threshold"
            hint="Keyboard and mouse inactivity for this long marks the session idle. Idle time is recorded, not deducted."
          >
            <span className="tabular font-medium">
              {intervalLabel(query.data.idle_threshold_seconds)}
            </span>
          </DefinitionRow>

          <DefinitionRow
            term="Tracked categories"
            hint={
              query.data.tracked_categories.length === 0
                ? "Empty means every application and site is recorded under the company's categorisation rules."
                : undefined
            }
          >
            {query.data.tracked_categories.length === 0 ? (
              <span className="text-muted-foreground">All activity</span>
            ) : (
              <span>{query.data.tracked_categories.join(", ")}</span>
            )}
          </DefinitionRow>
        </DefinitionList>
      ) : null}
    </Section>
  );
}
