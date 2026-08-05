"use client";

import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { describeError, useSession } from "@/lib/api";
import { useCompanyPolicy, usePublishPolicy } from "@/lib/queries/settings";
import {
  IDLE_THRESHOLD_OPTIONS,
  POLICY_ROLLOUT_NOTE,
  SCREENSHOT_INTERVAL_OPTIONS,
  intervalLabel,
  intervalOptionsWith,
  policyDraftFrom,
  policyDraftToInput,
  policyFormSchema,
  policyState,
  screenshotIntervalChoices,
  screenshotsPerDay,
  type PolicyDraft,
  type PolicyRecord,
} from "@/lib/queries/settings-view";

import {
  Confirmation,
  DefinitionList,
  DefinitionRow,
  FieldGrid,
  FormPanel,
  Notice,
  Section,
  ValueSkeleton,
} from "./section";

/**
 * The monitoring policy in force, and the form that publishes the next one.
 *
 * **Publish, never edit.** Consent is recorded against a policy version
 * (non-negotiable #1), so mutating the row an employee consented to would rewrite what
 * they agreed to after the fact. Every change here inserts a new version and leaves the
 * old one standing as history.
 *
 * Until this form existed a fresh tenant was stuck: `POST /api/devices/enroll` refuses
 * with `no_policy` when a company has none, so no agent could enrol at all and the only
 * remedy the screen offered was "publish through the API or a migration" — which is not
 * a remedy, it is a shrug.
 */
export function PolicySection() {
  const { data: session } = useSession();
  const query = useCompanyPolicy();
  const [editing, setEditing] = useState(false);
  /** The confirmation sentence, built from the row the server stored. Null until then. */
  const [published, setPublished] = useState<string | null>(null);

  const state = policyState({
    isLoading: query.isLoading,
    error: query.error,
    data: query.data,
  });

  // Mirrors the API preHandler on the write route. Offering a publish button to a
  // manager would be offering something the server refuses.
  const canPublish = session?.role === "super_admin";
  const showForm = canPublish && (editing || state === "missing");

  return (
    <Section
      title="Monitoring policy"
      description="What the desktop and Android agents are configured to collect. Publishing creates a new version; the previous one stays as history."
      actions={
        canPublish && state === "ready" && !editing ? (
          <Button variant="outline" size="sm" className="h-9" onClick={() => setEditing(true)}>
            Publish a new version
          </Button>
        ) : null
      }
    >
      {published ? (
        <Confirmation>
          <p className="font-medium">{published}</p>
          <p className="mt-0.5 text-muted-foreground">{POLICY_ROLLOUT_NOTE}</p>
        </Confirmation>
      ) : null}

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
          <DefinitionRow term="Tracked categories">
            <ValueSkeleton className="w-32" />
          </DefinitionRow>
        </DefinitionList>
      ) : null}

      {state === "missing" ? (
        <Notice tone="warning" title="No monitoring policy has been published yet">
          <p>
            Devices cannot enrol until one exists — the agent is told to stop rather than
            guess an interval.
            {canPublish
              ? " Publish the first version below and enrolment starts working immediately."
              : " Ask a super admin to publish the first version."}
          </p>
        </Notice>
      ) : null}

      {state === "forbidden" ? (
        // NOT "super admins only". `GET /api/policies/current` is `requireUser` and
        // the API says so deliberately: everyone signed in is entitled to read the
        // terms they are monitored under. A 403 here is therefore about the account,
        // not about the role, and the old copy asserted a rule that does not exist.
        <Notice title="This account could not read the monitoring policy">
          <p>
            Everyone signed in is meant to see the terms monitoring runs under, so a refusal
            points at the session rather than at your role. Sign in again, or ask an
            administrator to check this profile is still linked to the company.
          </p>
        </Notice>
      ) : null}

      {state === "error" ? (
        <Notice tone="error" title="Could not load the monitoring policy">
          <p>{describeError(query.error)}</p>
        </Notice>
      ) : null}

      {state === "ready" && query.data ? <PolicyFacts policy={query.data} /> : null}

      {showForm ? (
        <div className="mt-3">
          <PolicyForm
            current={query.data ?? null}
            firstVersion={state === "missing"}
            onCancel={state === "missing" ? null : () => setEditing(false)}
            onPublished={(version) => {
              setEditing(false);
              setPublished(
                version
                  ? `Version ${version} is now the policy in force.`
                  : "The new policy is now in force.",
              );
            }}
          />
        </div>
      ) : null}
    </Section>
  );
}

/** The policy as it stands, read from `GET /api/policies/current`. Nothing hardcoded. */
function PolicyFacts({ policy }: { policy: PolicyRecord }) {
  const standardInterval = SCREENSHOT_INTERVAL_OPTIONS.some(
    (option) => option.seconds === policy.screenshot_interval_seconds,
  );

  return (
    <DefinitionList>
      <DefinitionRow term="Policy version" hint={policy.name}>
        <span className="tabular font-medium">{policy.version}</span>
      </DefinitionRow>

      <DefinitionRow
        term="Screenshot interval"
        hint={`About ${screenshotsPerDay(policy.screenshot_interval_seconds)} captures over an eight-hour day.`}
      >
        <span className="tabular font-medium">
          {intervalLabel(policy.screenshot_interval_seconds)}
        </span>
        {!standardInterval ? (
          <span className="ml-2 text-xs text-muted-foreground">
            (outside the five standard intervals)
          </span>
        ) : null}
      </DefinitionRow>

      <DefinitionRow
        term="Idle threshold"
        hint="Keyboard and mouse inactivity for this long marks the session idle. Idle time is recorded, not deducted."
      >
        <span className="tabular font-medium">{intervalLabel(policy.idle_threshold_seconds)}</span>
      </DefinitionRow>

      <DefinitionRow
        term="Tracked categories"
        hint={
          policy.tracked_categories.length === 0
            ? "Empty means every application and site is recorded under the company's categorisation rules."
            : undefined
        }
      >
        {policy.tracked_categories.length === 0 ? (
          <span className="text-muted-foreground">All activity</span>
        ) : (
          <span>{policy.tracked_categories.join(", ")}</span>
        )}
      </DefinitionRow>

      <DefinitionRow term="Reaches agents">
        <span className="text-muted-foreground">{POLICY_ROLLOUT_NOTE}</span>
      </DefinitionRow>
    </DefinitionList>
  );
}

/**
 * React Hook Form + Zod, per `CLAUDE.md`.
 *
 * The schema delegates to `validatePolicyDraft`, which is the same function the panel
 * validated with before and is covered by its own tests — so the form gained a
 * resolver without the validation rules being rewritten into a second place.
 */
function PolicyForm({
  current,
  firstVersion,
  onCancel,
  onPublished,
}: {
  current: PolicyRecord | null;
  firstVersion: boolean;
  onCancel: (() => void) | null;
  onPublished: (version: string | null) => void;
}) {
  const mutation = usePublishPolicy();

  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<PolicyDraft>({
    resolver: zodResolver(policyFormSchema(current ? [current.version] : [])),
    defaultValues: policyDraftFrom(current),
  });

  const screenshotSeconds = watch("screenshotIntervalSeconds");
  const idleSeconds = watch("idleThresholdSeconds");
  const screenshotOptions = screenshotIntervalChoices(screenshotSeconds);
  const idleOptions = intervalOptionsWith(IDLE_THRESHOLD_OPTIONS, idleSeconds);

  return (
    <FormPanel
      title={firstVersion ? "Publish the first policy" : "Publish a new version"}
      description={
        firstVersion
          ? "These are the terms every agent enforces and every employee consents to. They can be changed later by publishing another version."
          : "The version in force stays as history. Consent already recorded is against the version it was given, not this one."
      }
      onSubmit={handleSubmit((draft) => {
        // The version in the confirmation comes from the stored row, never from the
        // draft: it is usually the server's to mint, and echoing back what was typed
        // would print a version that does not exist.
        mutation.mutate(policyDraftToInput(draft), {
          onSuccess: (policy) => onPublished(policy?.version ?? null),
        });
      })}
    >
      <div className="mt-4">
        <FieldGrid>
          <Field
            label="Version (optional)"
            hint="Leave blank and the server assigns the next version in its YYYY.MM.N series. Set one only to mirror a label agreed elsewhere — it is quoted in every consent record."
            error={errors.version?.message}
          >
            {(field) => (
              <Input {...field} {...register("version")} placeholder="Assigned automatically" />
            )}
          </Field>

          <Field
            label="Policy name"
            hint="What an employee sees when they are asked to consent."
            error={errors.name?.message}
          >
            {(field) => <Input {...field} {...register("name")} />}
          </Field>

          <Field
            label="Screenshot interval"
            hint={`About ${screenshotsPerDay(screenshotSeconds)} captures over an eight-hour day.`}
            error={errors.screenshotIntervalSeconds?.message}
          >
            {(field) => (
              <Controller
                control={control}
                name="screenshotIntervalSeconds"
                render={({ field: control }) => (
                  <Select
                    value={String(control.value)}
                    onValueChange={(value) => control.onChange(Number(value))}
                  >
                    <SelectTrigger {...field}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {screenshotOptions.map((option) => (
                        <SelectItem key={option.seconds} value={String(option.seconds)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          <Field
            label="Idle threshold"
            hint="Inactivity for this long marks the session idle. Idle time is recorded, never deducted."
            error={errors.idleThresholdSeconds?.message}
          >
            {(field) => (
              <Controller
                control={control}
                name="idleThresholdSeconds"
                render={({ field: control }) => (
                  <Select
                    value={String(control.value)}
                    onValueChange={(value) => control.onChange(Number(value))}
                  >
                    <SelectTrigger {...field}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {idleOptions.map((option) => (
                        <SelectItem key={option.seconds} value={String(option.seconds)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>
        </FieldGrid>

        <div className="mt-3.5">
          <Field
            label="Tracked categories"
            hint="Comma-separated. Leave empty to record all activity and let the category rules below classify it."
            error={errors.trackedCategories?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...register("trackedCategories")}
                placeholder="Development, Communication, Research"
              />
            )}
          </Field>
        </div>
      </div>

      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{POLICY_ROLLOUT_NOTE}</p>

      {mutation.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(mutation.error)}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={onCancel}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" className="h-9" disabled={mutation.isPending}>
          {mutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Publishing
            </>
          ) : (
            "Publish"
          )}
        </Button>
      </div>
    </FormPanel>
  );
}
