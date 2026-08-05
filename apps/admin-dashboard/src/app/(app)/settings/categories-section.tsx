"use client";

import { Badge, Button } from "@aems/ui";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { useId, useState } from "react";

import { describeError, useSession } from "@/lib/api";
import {
  useCategoryRules,
  useCreateCategoryRule,
  useDeleteCategoryRule,
  useUpdateCategoryRule,
} from "@/lib/queries/settings";
import {
  EMPTY_RULE_DRAFT,
  PRODUCTIVITY_OPTIONS,
  describeRejection,
  formatRulePath,
  hasErrors,
  productivityBadgeVariant,
  productivityLabel,
  rejectionConsequence,
  ruleConditions,
  ruleDraftFrom,
  ruleDraftToInput,
  rulesWithRejections,
  validateRuleDraft,
  type CategoryRuleDto,
  type Productivity,
  type RuleDraft,
  type RuleDraftErrors,
} from "@/lib/queries/settings-view";

import { Field, FieldGrid, Notice, Section, controlClass } from "./section";

/**
 * How activity is classified, and the only place it can be changed.
 *
 * The rules are company data, evaluated server-side at ingestion *and* recomputed on
 * read — which is what lets a rule added today relabel yesterday's history without a
 * backfill. Four endpoints have existed for this since the categorisation engine
 * shipped and nothing in the dashboard called any of them, so every company was
 * frozen on whatever the seed installed.
 *
 * Two things this panel must do that a plain CRUD table would not:
 *
 *  1. **Show the refusals.** `compileRules` skips a rule it cannot run rather than
 *     failing the whole batch, so a bad pattern is silent everywhere else — activity
 *     just quietly stops being classified. `GET /api/activity/categories` returns
 *     `rejected` for this screen specifically, and this is where it gets repaired.
 *  2. **Show evaluation order.** First match wins. A rule list that does not say what
 *     runs first cannot explain why a rule "isn't working".
 */
export function CategoriesSection() {
  const { data: session } = useSession();
  const query = useCategoryRules();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // POST / PATCH / DELETE on /api/activity/categories are all `requireSuperAdmin` —
  // a manager who could rewrite the rules could rewrite the report.
  const canEdit = session?.role === "super_admin";
  const rows = rulesWithRejections(query.data);
  const rejectedCount = query.data?.rejected.length ?? 0;

  return (
    <Section
      title="Category rules"
      description="How applications and websites are classified. Rules are evaluated in priority order and the first one that matches wins; anything unmatched is recorded as Uncategorized and counted as neutral."
      actions={
        canEdit && !creating ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingId(null);
              setCreating(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add rule
          </Button>
        ) : null
      }
    >
      {query.isError ? (
        <Notice tone="error" title="Could not load the category rules">
          <p>{describeError(query.error)}</p>
        </Notice>
      ) : (
        <>
          {rejectedCount > 0 ? (
            <div className="mb-3">
              <Notice tone="warning" title="Some rules cannot be run">
                <p>{rejectionConsequence(rejectedCount)}</p>
                <p className="mt-1">
                  {canEdit
                    ? "Each one is marked below with the reason the engine gave. Edit it to fix the pattern, or delete it."
                    : "Ask a super admin to repair them."}
                </p>
              </Notice>
            </div>
          ) : null}

          {creating ? (
            <div className="mb-3">
              <RuleForm
                title="New rule"
                initial={EMPTY_RULE_DRAFT}
                ruleId={null}
                onDone={() => setCreating(false)}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">
                Category rules in evaluation order, with the conditions each applies
              </caption>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Priority
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Category
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Classified as
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Matches when
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    {canEdit ? "Change" : ""}
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.isLoading ? (
                  <RuleSkeleton />
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center">
                      <p className="text-sm font-medium">No category rules yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {canEdit
                          ? "Every application and site is being recorded as Uncategorized and counted as neutral. Add a rule to start classifying it."
                          : "All activity is recorded as Uncategorized until a super admin adds a rule."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  rows.map(({ rule, rejection }) =>
                    editingId === rule.id ? (
                      <tr key={rule.id} className="border-b last:border-0">
                        <td colSpan={5} className="px-4 py-3">
                          <RuleForm
                            title={`Edit “${formatRulePath(rule.path)}”`}
                            initial={ruleDraftFrom(rule)}
                            ruleId={rule.id}
                            onDone={() => setEditingId(null)}
                            onCancel={() => setEditingId(null)}
                          />
                        </td>
                      </tr>
                    ) : (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        rejection={rejection ? describeRejection(rejection) : null}
                        canEdit={canEdit}
                        onEdit={() => {
                          setCreating(false);
                          setEditingId(rule.id);
                        }}
                      />
                    ),
                  )
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

function RuleSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <tr key={index} className="border-b last:border-0">
          <td className="px-4 py-2.5">
            <span className="block h-4 w-8 animate-pulse rounded bg-muted" />
          </td>
          <td className="px-4 py-2.5">
            <span className="block h-4 w-36 animate-pulse rounded bg-muted" />
          </td>
          <td className="px-4 py-2.5">
            <span className="block h-4 w-20 animate-pulse rounded bg-muted" />
          </td>
          <td className="px-4 py-2.5">
            <span className="block h-4 w-48 animate-pulse rounded bg-muted" />
          </td>
          <td className="px-4 py-2.5" />
        </tr>
      ))}
    </>
  );
}

function RuleRow({
  rule,
  rejection,
  canEdit,
  onEdit,
}: {
  rule: CategoryRuleDto;
  rejection: string | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteCategoryRule();
  const conditions = ruleConditions(rule);

  return (
    <>
      <tr className="border-b transition-colors last:border-0 hover:bg-secondary/40">
        <td className="tabular px-4 py-2.5 text-muted-foreground">{rule.priority}</td>
        <td className="px-4 py-2.5">
          <span className="font-medium">{formatRulePath(rule.path)}</span>
          {rejection ? (
            <span className="mt-0.5 flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span className="text-muted-foreground">Skipped — {rejection}</span>
            </span>
          ) : null}
        </td>
        <td className="px-4 py-2.5">
          <Badge variant={productivityBadgeVariant(rule.productivity)}>
            {productivityLabel(rule.productivity)}
          </Badge>
        </td>
        <td className="px-4 py-2.5">
          <ul className="space-y-0.5">
            {conditions.map((condition) => (
              <li key={condition.label} className="text-xs">
                <span className="text-muted-foreground">{condition.label}</span>{" "}
                <code className="rounded bg-secondary px-1 py-0.5 font-mono">
                  {condition.value}
                </code>
              </li>
            ))}
            {conditions.length === 0 ? (
              <li className="text-xs text-muted-foreground">No conditions</li>
            ) : null}
            {conditions.length > 0 && !rule.ignoreCase ? (
              <li className="text-xs text-muted-foreground">Case sensitive</li>
            ) : null}
          </ul>
        </td>
        <td className="px-4 py-2.5 text-right">
          {canEdit && !confirming ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  remove.reset();
                  setConfirming(true);
                }}
              >
                Delete
              </Button>
            </div>
          ) : null}
        </td>
      </tr>

      {confirming ? (
        <tr className="border-b bg-secondary/30 last:border-0">
          <td colSpan={5} className="px-4 py-3">
            <div className="flex flex-wrap items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  Delete “{formatRulePath(rule.path)}”?
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Activity this rule claimed falls through to the next matching rule, or to
                  Uncategorized. Reports recompute from the rules in force, so history changes
                  too — nothing is deleted, but it is relabelled.
                </p>
                {remove.isError ? (
                  <p role="alert" className="mt-1.5 text-sm text-destructive">
                    {describeError(remove.error)}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={remove.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(rule.id, { onSuccess: () => setConfirming(false) })}
                >
                  {remove.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Deleting
                    </>
                  ) : (
                    "Delete rule"
                  )}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Create and edit share one form.
 *
 * Both endpoints take the same body and the same refusals apply, so two forms would
 * be two places for the validation to drift apart.
 */
function RuleForm({
  title,
  initial,
  ruleId,
  onDone,
  onCancel,
}: {
  title: string;
  initial: RuleDraft;
  ruleId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [errors, setErrors] = useState<RuleDraftErrors>({});

  const create = useCreateCategoryRule();
  const update = useUpdateCategoryRule();
  const active = ruleId === null ? create : update;

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    // All of them, not just this field: the engine judges the rule as a whole, so
    // typing into Domain can be what fixes an error currently blamed on the rule.
    setErrors({});
  };

  return (
    <form
      className="rounded-lg border bg-card px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        const found = validateRuleDraft(draft);
        setErrors(found);
        if (hasErrors(found)) return;

        const input = ruleDraftToInput(draft);
        if (ruleId === null) create.mutate(input, { onSuccess: onDone });
        else update.mutate({ id: ruleId, input }, { onSuccess: onDone });
      }}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
        Every condition you set must match. Patterns are regular expressions, except a bare
        hostname in Domain, which matches that host and its subdomains.
      </p>

      <div className="mt-4">
        <FieldGrid>
          <Field
            label="Category"
            htmlFor={`${fieldId}-path`}
            hint="Up to four levels, separated by > or /."
            error={errors.path}
          >
            <input
              id={`${fieldId}-path`}
              className={controlClass}
              value={draft.path}
              placeholder="Work > Development"
              onChange={(event) => set("path", event.target.value)}
              aria-invalid={errors.path ? true : undefined}
              aria-describedby={errors.path ? `${fieldId}-path-error` : `${fieldId}-path-hint`}
            />
          </Field>

          <Field
            label="Classified as"
            htmlFor={`${fieldId}-productivity`}
            hint="Drives the work-pattern split on every report."
          >
            <select
              id={`${fieldId}-productivity`}
              className={controlClass}
              value={draft.productivity}
              onChange={(event) => set("productivity", event.target.value as Productivity)}
            >
              {PRODUCTIVITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Application matches"
            htmlFor={`${fieldId}-app`}
            hint="Regular expression tested against the application name."
            error={errors.matchApp}
          >
            <input
              id={`${fieldId}-app`}
              className={`${controlClass} font-mono`}
              value={draft.matchApp}
              placeholder="^(Code|WebStorm)"
              onChange={(event) => set("matchApp", event.target.value)}
              aria-invalid={errors.matchApp ? true : undefined}
              aria-describedby={errors.matchApp ? `${fieldId}-app-error` : `${fieldId}-app-hint`}
            />
          </Field>

          <Field
            label="Domain matches"
            htmlFor={`${fieldId}-domain`}
            hint="A bare hostname matches its subdomains too."
            error={errors.matchDomain}
          >
            <input
              id={`${fieldId}-domain`}
              className={`${controlClass} font-mono`}
              value={draft.matchDomain}
              placeholder="github.com"
              onChange={(event) => set("matchDomain", event.target.value)}
              aria-invalid={errors.matchDomain ? true : undefined}
              aria-describedby={
                errors.matchDomain ? `${fieldId}-domain-error` : `${fieldId}-domain-hint`
              }
            />
          </Field>

          <Field
            label="Window title matches"
            htmlFor={`${fieldId}-title`}
            hint="Regular expression tested against the window title."
            error={errors.matchTitle}
          >
            <input
              id={`${fieldId}-title`}
              className={`${controlClass} font-mono`}
              value={draft.matchTitle}
              onChange={(event) => set("matchTitle", event.target.value)}
              aria-invalid={errors.matchTitle ? true : undefined}
              aria-describedby={
                errors.matchTitle ? `${fieldId}-title-error` : `${fieldId}-title-hint`
              }
            />
          </Field>

          <Field
            label="Priority"
            htmlFor={`${fieldId}-priority`}
            hint="Lower runs first. Evaluation stops at the first rule that matches."
            error={errors.priority}
          >
            <input
              id={`${fieldId}-priority`}
              className={controlClass}
              inputMode="numeric"
              value={draft.priority}
              onChange={(event) => set("priority", event.target.value)}
              aria-invalid={errors.priority ? true : undefined}
              aria-describedby={
                errors.priority ? `${fieldId}-priority-error` : `${fieldId}-priority-hint`
              }
            />
          </Field>
        </FieldGrid>

        <label className="mt-3.5 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={!draft.ignoreCase}
            onChange={(event) => set("ignoreCase", !event.target.checked)}
          />
          <span>Match case exactly</span>
        </label>
      </div>

      {errors.match ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {errors.match}
        </p>
      ) : null}

      {active.isError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(active.error)}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={active.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={active.isPending}>
          {active.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Saving
            </>
          ) : ruleId === null ? (
            "Add rule"
          ) : (
            "Save rule"
          )}
        </Button>
      </div>
    </form>
  );
}
