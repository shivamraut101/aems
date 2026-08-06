"use client";

import {
  Badge,
  Button,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { RelativeTime } from "@/components/relative-time";
import { ErrorState, TableSkeletonRows, type SkeletonColumn } from "@/components/states";
import { describeError, useApiQuery, useSession } from "@/lib/api";
import {
  MATCH_KIND_LABEL,
  MAX_RULES_PER_COMPANY,
  RESTRICTION_ROLLOUT_NOTE,
  actionEffect,
  modeCopy,
  rejectionsById,
  restrictionPolicyQuery,
  restrictionSettingsFormFrom,
  restrictionSettingsSchema,
  restrictionSettingsToInput,
  ruleReach,
  settingsChangeConsequence,
  useDeleteRestrictionRule,
  useSaveRestrictionSettings,
  useUpdateRestrictionRule,
  type RestrictionMode,
  type RestrictionRule,
  type RestrictionSettings,
  type RestrictionSettingsForm,
} from "@/lib/queries/restrictions";

import {
  ConfirmPanel,
  Confirmation,
  DefinitionList,
  DefinitionRow,
  FormPanel,
  Notice,
  Section,
  ValueSkeleton,
} from "../section";
import { Refusals } from "./refusals";
import { RuleDialog } from "./rule-dialog";

/**
 * Website access.
 *
 * In scope by the client decision of 2026-08-05 recorded in `CLAUDE.md`, which
 * overrides `docs/scope.md` §8 for website restriction and for nothing else. It is one
 * piece of work with website *tracking* because it is one mechanism: on Windows there
 * is no supported way to read a browser's address bar, so the managed extension that
 * reports a URL is the same component that can refuse one.
 *
 * The screen is deliberately ordered how it is: the **posture** first, because a rule
 * means the opposite thing under an allow list and means nothing at all while
 * enforcement is off; then the rules; then what they have actually refused. Reading top
 * to bottom answers "is this on, what does it say, and what is it doing" in that order.
 *
 * Copy rule, from the same decision: enforcement makes the product's non-surveillance
 * framing more fragile rather than less, so nothing here is written as punishment. Every
 * rule can carry the reason an employee sees, and the refusal list is introduced as the
 * way to find a rule that is refusing more than it was meant to.
 */
const RULE_SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { key: "pattern", label: "Website or pattern", lines: 2, width: "w-40" },
  { key: "effect", label: "Effect", width: "w-16" },
  { key: "order", label: "Order", align: "right", width: "w-8" },
  { key: "reason", label: "Reason employees see", width: "w-48" },
  { key: "change", label: "", align: "right", width: "w-32" },
];

export function RestrictionsView() {
  const { data: session } = useSession();
  const query = useApiQuery(restrictionPolicyQuery);

  const [dialog, setDialog] = useState<{ rule: RestrictionRule | null } | null>(null);

  // Every write under /api/restrictions is `requireSuperAdmin`, in line with every other
  // company-configuration write. The screen must not offer what the preHandler refuses.
  const canEdit = session?.role === "super_admin";

  const policy = query.data;
  const rules = policy?.rules ?? [];
  const rejected = rejectionsById(policy?.rejected ?? []);
  const settings = policy?.settings;
  const mode: RestrictionMode = settings?.mode ?? "blocklist";
  const enforcing = settings?.enabled ?? false;
  const copy = modeCopy(mode);

  if (query.isError) {
    return (
      <Section title="Website access">
        <ErrorState
          title="Could not load the website policy"
          message={`${describeError(query.error)} Nothing has changed on employees’ devices — this page could not read the policy, not change it. Whatever rules are stored are still being enforced.`}
          onRetry={() => void query.refetch()}
        />
      </Section>
    );
  }

  return (
    <>
      <PostureSection
        settings={settings ?? null}
        ruleCount={rules.length}
        isLoading={query.isLoading}
        canEdit={canEdit}
      />

      <Section
        title={copy.listHeading}
        description={copy.listDescription}
        affects="every company device running the managed browser extension. Personal machines are never reached."
        actions={
          canEdit ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={rules.length >= MAX_RULES_PER_COMPANY}
              onClick={() => setDialog({ rule: null })}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add a rule
            </Button>
          ) : null
        }
      >
        {!enforcing && !query.isLoading && rules.length > 0 ? (
          <div className="mb-3">
            <Notice tone="warning" title="These rules are not being enforced">
              <p>
                Website enforcement is switched off above, so every site opens normally on
                company devices. The rules are kept exactly as written and take effect again
                as soon as it is switched back on.
              </p>
            </Notice>
          </div>
        ) : null}

        {!query.isLoading && rules.length > 0 ? (
          <p className="mb-2 text-sm text-muted-foreground">
            <span className="tabular font-medium text-foreground">{rules.length}</span>{" "}
            {rules.length === 1 ? "rule" : "rules"}
            {/* Paused rules are in the table and look like the rest of it until a reader
                gets to the Effect column, so the count says how many are actually live. */}
            {rules.some((rule) => !rule.enabled) ? (
              <>
                {", "}
                <span className="tabular">{rules.filter((rule) => rule.enabled).length}</span> of
                them active
              </>
            ) : null}
            . The lowest order number that matches decides.
          </p>
        ) : null}

        <Table
          containerClassName="rounded-lg border bg-card"
          className="min-w-[52rem]"
          aria-busy={query.isLoading || undefined}
        >
          <caption className="sr-only">
            Website rules: what each one matches, whether it blocks or allows, the order it is
            evaluated in, and the reason employees are shown
          </caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col">Website or pattern</TableHead>
              <TableHead scope="col">Effect</TableHead>
              <TableHead scope="col" className="text-right">
                Order
              </TableHead>
              <TableHead scope="col">Reason employees see</TableHead>
              <TableHead scope="col" className="text-right">
                {canEdit ? "Change" : ""}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading ? (
              <TableSkeletonRows columns={RULE_SKELETON_COLUMNS} rows={4} />
            ) : rules.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="px-4 py-10 text-center">
                  <p className="text-sm font-medium">No website rules yet</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                    {mode === "allowlist"
                      ? "An allow list with no rules would refuse every website, so nothing is enforced until at least one site is allowed."
                      : canEdit
                        ? "Every website is available on company devices. Add a rule to start restricting one."
                        : "Every website is available on company devices."}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  rejection={rejected.get(rule.id)?.reason ?? null}
                  canEdit={canEdit}
                  onEdit={() => setDialog({ rule })}
                />
              ))
            )}
          </TableBody>
        </Table>

        {rules.length >= MAX_RULES_PER_COMPANY ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This company is holding the maximum of {MAX_RULES_PER_COMPANY} rules. Remove one
            before adding another — the whole set loads in every browser, so the limit is
            there to keep a laptop starting quickly.
          </p>
        ) : null}
      </Section>

      <Refusals rules={rules} mode={mode} />

      {dialog ? (
        <RuleDialog
          mode={mode}
          enforcing={enforcing}
          rule={dialog.rule}
          rules={rules}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The company-wide posture: the master switch, the mode, and the sentence employees read.
 *
 * One form rather than three controls, because `PUT /api/restrictions/settings` takes all
 * three together — three separate switches would each have to send the other two, and a
 * stale one would silently undo a change made a second earlier.
 *
 * It asks before it saves anything consequential. `settingsChangeConsequence` returns
 * null when nothing that affects a browser changed (editing only the notice), and then
 * the save goes straight through: a confirmation dialog for a copy edit teaches people to
 * dismiss confirmations.
 */
function PostureSection({
  settings,
  ruleCount,
  isLoading,
  canEdit,
}: {
  settings: RestrictionSettings | null;
  ruleCount: number;
  isLoading: boolean;
  canEdit: boolean;
}) {
  const mutation = useSaveRestrictionSettings();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const mode: RestrictionMode = settings?.mode ?? "blocklist";
  const copy = modeCopy(mode);

  return (
    <Section
      title="Website access"
      description="Which websites can be opened on company devices. Enforced by the managed browser extension that also reports website usage; nothing here touches a personal machine."
      affects="every employee at once. Switching the mode changes what every rule below means, not just what one of them does."
      actions={
        canEdit && !editing && !isLoading ? (
          <Button variant="outline" size="sm" className="h-9" onClick={() => setEditing(true)}>
            Change website access
          </Button>
        ) : null
      }
    >
      {saved ? (
        <Confirmation>
          <p className="font-medium">{saved}</p>
          <p className="mt-0.5 text-muted-foreground">{RESTRICTION_ROLLOUT_NOTE}</p>
        </Confirmation>
      ) : null}

      <DefinitionList>
        <DefinitionRow
          term="Enforcement"
          hint={
            settings?.enabled
              ? undefined
              : "While this is off the extension still reports website usage; it just refuses nothing."
          }
        >
          {isLoading ? (
            <ValueSkeleton className="w-20" />
          ) : (
            <Badge variant={settings?.enabled ? "online" : "offline"} dot>
              {settings?.enabled ? "On" : "Off"}
            </Badge>
          )}
        </DefinitionRow>

        <DefinitionRow term="How the rules read" hint={copy.summary}>
          {isLoading ? <ValueSkeleton className="w-24" /> : <span className="font-medium">{copy.label}</span>}
        </DefinitionRow>

        <DefinitionRow
          term="Message on a refused page"
          hint="Employees see this instead of a bare refusal, so nobody has to guess or ask around."
        >
          {isLoading ? (
            <ValueSkeleton className="w-48" />
          ) : settings?.notice ? (
            <span>{settings.notice}</span>
          ) : (
            <span className="text-warning">
              Not set — a refused page would say only that it was blocked
            </span>
          )}
        </DefinitionRow>

        <DefinitionRow term="Last changed">
          {isLoading ? (
            <ValueSkeleton className="w-24" />
          ) : (
            <span className="text-muted-foreground">
              {settings?.updatedAt ? <RelativeTime iso={settings.updatedAt} /> : "Never"}
            </span>
          )}
        </DefinitionRow>

        <DefinitionRow term="Reaches devices">
          <span className="text-muted-foreground">{RESTRICTION_ROLLOUT_NOTE}</span>
        </DefinitionRow>
      </DefinitionList>

      {canEdit && editing ? (
        <div className="mt-3">
          <PostureForm
            settings={settings}
            ruleCount={ruleCount}
            saving={mutation.isPending}
            error={mutation.isError ? describeError(mutation.error) : null}
            onCancel={() => {
              mutation.reset();
              setEditing(false);
            }}
            onSubmit={(values, confirmation) => {
              mutation.mutate(restrictionSettingsToInput(values), {
                onSuccess: () => {
                  setEditing(false);
                  setSaved(confirmation);
                },
              });
            }}
          />
        </div>
      ) : null}
    </Section>
  );
}

function PostureForm({
  settings,
  ruleCount,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  settings: RestrictionSettings | null;
  ruleCount: number;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: RestrictionSettingsForm, confirmation: string) => void;
}) {
  const current: Pick<RestrictionSettings, "enabled" | "mode"> = {
    enabled: settings?.enabled ?? false,
    mode: settings?.mode ?? "blocklist",
  };

  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<RestrictionSettingsForm>({
    resolver: zodResolver(restrictionSettingsSchema),
    defaultValues: restrictionSettingsFormFrom(
      settings ?? { enabled: false, mode: "blocklist", notice: null, revision: 0, updatedAt: null },
    ),
  });

  const next = { enabled: watch("enabled"), mode: watch("mode") };
  const consequence = settingsChangeConsequence(next, current, ruleCount);
  const [confirming, setConfirming] = useState<RestrictionSettingsForm | null>(null);

  const confirmationFor = (values: RestrictionSettingsForm): string => {
    if (!values.enabled) return "Website enforcement is off. Every site opens normally on company devices.";
    return values.mode === "allowlist"
      ? "Website access is now an allow list. Only what these rules allow can be opened on company devices."
      : "Website access is now a block list. Every site opens except the ones these rules block.";
  };

  return (
    <FormPanel
      title="Change website access"
      description="These three settings travel together: the extension reads all of them on every refresh."
      onSubmit={handleSubmit((values) => {
        // A change that alters what a browser does is confirmed first; editing only the
        // message is not, because a confirmation for a copy edit teaches people to click
        // through confirmations.
        if (consequence) setConfirming(values);
        else onSubmit(values, confirmationFor(values));
      })}
    >
      <div className="mt-4 flex flex-col gap-3.5">
        <Controller
          control={control}
          name="enabled"
          render={({ field }) => (
            <SwitchField
              containerClassName="rounded-md border px-3 py-2.5"
              label="Enforce website rules"
              description="Off means the extension refuses nothing at all. It keeps reporting website usage either way, and the rules are kept."
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />

        <Field
          label="How the rules read"
          hint={modeCopy(next.mode).summary}
          error={errors.mode?.message}
        >
          {(field) => (
            <Controller
              control={control}
              name="mode"
              render={({ field: mode }) => (
                <Select value={mode.value} onValueChange={mode.onChange} disabled={!next.enabled}>
                  <SelectTrigger {...field} className="sm:w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blocklist">{modeCopy("blocklist").label}</SelectItem>
                    <SelectItem value="allowlist">{modeCopy("allowlist").label}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          )}
        </Field>

        <Field
          label="Message on a refused page"
          hint="Shown to the employee instead of a bare refusal. Name who to ask — a page that only says “blocked” is what the design direction rules out."
          error={errors.notice?.message}
        >
          {(field) => (
            <Textarea
              {...field}
              {...register("notice")}
              rows={2}
              placeholder="This site is not part of company work. Ask your manager if you need access for a task."
            />
          )}
        </Field>
      </div>

      {consequence && !confirming ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0">{consequence}</span>
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {confirming ? (
        <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3.5">
          <ConfirmPanel
            title="Save this change to website access?"
            detail={consequence ?? ""}
            error={error}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => setConfirming(null)}
              disabled={saving}
            >
              Go back
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-9"
              disabled={saving}
              onClick={() => onSubmit(confirming, confirmationFor(confirming))}
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Saving
                </>
              ) : (
                "Save and apply"
              )}
            </Button>
          </ConfirmPanel>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" className="h-9" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      )}
    </FormPanel>
  );
}

function RuleRow({
  rule,
  rejection,
  canEdit,
  onEdit,
}: {
  rule: RestrictionRule;
  /** Why the matcher refused to compile this rule, if it did. */
  rejection: string | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteRestrictionRule();
  const update = useUpdateRestrictionRule();

  return (
    <>
      <TableRow>
        <TableCell>
          <span className="break-all font-mono font-medium">{rule.pattern}</span>
          <p className="text-xs text-muted-foreground">
            {MATCH_KIND_LABEL[rule.matchKind]} · {ruleReach(rule)}
          </p>
          {rejection ? (
            // The API compiles every rule on read and hands back the ones it could not
            // use. A rule that never fires while an admin believes it is protecting them
            // is the worst state this screen can be in, so it is said in the row rather
            // than left to be discovered.
            <p className="mt-0.5 flex items-start gap-1 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>This rule is never applied: {rejection.toLowerCase()}.</span>
            </p>
          ) : null}
        </TableCell>
        <TableCell>
          {rule.enabled ? (
            <Badge variant={rule.action === "block" ? "revoked" : "online"}>
              {actionEffect(rule.action)}
            </Badge>
          ) : (
            <Badge variant="offline">Paused</Badge>
          )}
        </TableCell>
        <TableCell className="tabular text-right text-muted-foreground">{rule.priority}</TableCell>
        <TableCell className="text-muted-foreground">
          {rule.note ?? (
            // Not a blank cell. A rule with no reason produces a refusal page an employee
            // cannot act on, which is the thing CLAUDE.md rules out by name. The
            // company-wide notice still shows, so this is a warning, not an error.
            <span className="text-warning">Uses the company message only</span>
          )}
        </TableCell>
        <TableCell className="text-right">
          {canEdit && !confirming ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: rule.id, input: { enabled: !rule.enabled } })}
              >
                {rule.enabled ? "Pause" : "Resume"}
              </Button>
              <Button variant="outline" size="sm" className="h-9" onClick={onEdit}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => {
                  remove.reset();
                  setConfirming(true);
                }}
              >
                Remove
              </Button>
            </div>
          ) : null}
          {update.isError ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {describeError(update.error)}
            </p>
          ) : null}
        </TableCell>
      </TableRow>

      {confirming ? (
        <TableRow className="bg-secondary/30 hover:bg-secondary/30">
          <TableCell colSpan={5} className="px-4 py-3">
            <ConfirmPanel
              title={`Remove the rule for ${rule.pattern}?`}
              detail={
                rule.action === "block"
                  ? "The site becomes reachable again on company devices at the next policy refresh, unless an allow list refuses it for another reason. Refusals already recorded are kept. Pause the rule instead if this is meant to be temporary."
                  : "This exception disappears, so whatever it was allowing goes back to being decided by the other rules and the company's posture. Pause it instead if this is meant to be temporary."
              }
              error={remove.isError ? describeError(remove.error) : null}
            >
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => setConfirming(false)}
                disabled={remove.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-9"
                disabled={remove.isPending}
                onClick={() => remove.mutate(rule.id, { onSuccess: () => setConfirming(false) })}
              >
                {remove.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Removing
                  </>
                ) : (
                  "Remove rule"
                )}
              </Button>
            </ConfirmPanel>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
