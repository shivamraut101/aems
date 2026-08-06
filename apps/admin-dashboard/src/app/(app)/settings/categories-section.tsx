"use client";

import {
  Badge,
  Button,
  CheckboxField,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { ErrorState, TableSkeletonRows, type SkeletonColumn } from "@/components/states";
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
  productivityBadgeVariant,
  productivityLabel,
  rejectionConsequence,
  ruleConditions,
  ruleDraftFrom,
  ruleDraftToInput,
  ruleFormSchema,
  rulesWithRejections,
  type CategoryRuleDto,
  type Productivity,
  type RuleDraft,
} from "@/lib/queries/settings-view";

import { ConfirmPanel, FieldGrid, FormPanel, Notice, Section } from "./section";

/**
 * How activity is classified, and the only place it can be changed.
 *
 * The rules are company data, evaluated server-side at ingestion *and* recomputed on
 * read — which is what lets a rule added today relabel yesterday's history without a
 * backfill.
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
const RULE_SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { key: "priority", label: "Priority", width: "w-8" },
  { key: "category", label: "Category", width: "w-36" },
  { key: "classified", label: "Classified as", width: "w-20" },
  { key: "matches", label: "Matches when", width: "w-48" },
  { key: "change", label: "", align: "right", width: "w-16" },
];

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
      id="categories"
      title="Category rules"
      description="How applications and websites are classified. Rules are evaluated in priority order and the first one that matches wins; anything unmatched is recorded as Uncategorized and counted as neutral."
      affects="every report, for everyone — including days already recorded, because reports are recomputed from the rules in force rather than from the labels stored at the time."
      actions={
        canEdit && !creating ? (
          <Button
            variant="outline"
            size="sm"
            className="h-9"
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
        <ErrorState
          title="Could not load the category rules"
          message={`${describeError(query.error)} Classification carries on running on the server from the rules already stored — this panel could not read them, not stop them.`}
          onRetry={() => void query.refetch()}
        />
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

          {!query.isLoading && rows.length > 0 ? (
            <p className="mb-2 text-sm text-muted-foreground">
              <span className="tabular font-medium text-foreground">{rows.length}</span>{" "}
              {rows.length === 1 ? "rule" : "rules"}, evaluated top to bottom.
            </p>
          ) : null}

          <Table
            containerClassName="rounded-lg border bg-card"
            className="min-w-[46rem]"
            aria-busy={query.isLoading || undefined}
          >
            <caption className="sr-only">
              Category rules in evaluation order, with the conditions each applies
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Priority</TableHead>
                <TableHead scope="col">Category</TableHead>
                <TableHead scope="col">Classified as</TableHead>
                <TableHead scope="col">Matches when</TableHead>
                <TableHead scope="col" className="text-right">
                  {canEdit ? "Change" : ""}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading ? (
                <TableSkeletonRows columns={RULE_SKELETON_COLUMNS} rows={4} />
              ) : rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium">No category rules yet</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                      {canEdit
                        ? "Every application and site is being recorded as Uncategorized and counted as neutral. Add a rule to start classifying it."
                        : "All activity is recorded as Uncategorized until a super admin adds a rule."}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(({ rule, rejection }) =>
                  editingId === rule.id ? (
                    <TableRow key={rule.id} className="hover:bg-transparent">
                      <TableCell colSpan={5} className="px-4 py-3">
                        <RuleForm
                          title={`Edit “${formatRulePath(rule.path)}”`}
                          initial={ruleDraftFrom(rule)}
                          ruleId={rule.id}
                          onDone={() => setEditingId(null)}
                          onCancel={() => setEditingId(null)}
                        />
                      </TableCell>
                    </TableRow>
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
            </TableBody>
          </Table>
        </>
      )}
    </Section>
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
      <TableRow>
        <TableCell className="tabular text-muted-foreground">{rule.priority}</TableCell>
        <TableCell>
          <span className="font-medium">{formatRulePath(rule.path)}</span>
          {rejection ? (
            <span className="mt-0.5 flex items-start gap-1.5 text-xs">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden />
              <span className="text-muted-foreground">Skipped — {rejection}</span>
            </span>
          ) : null}
        </TableCell>
        <TableCell>
          <Badge variant={productivityBadgeVariant(rule.productivity)}>
            {productivityLabel(rule.productivity)}
          </Badge>
        </TableCell>
        <TableCell>
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
        </TableCell>
        <TableCell className="text-right">
          {canEdit && !confirming ? (
            <div className="flex justify-end gap-2">
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
                Delete
              </Button>
            </div>
          ) : null}
        </TableCell>
      </TableRow>

      {confirming ? (
        <TableRow className="bg-secondary/30 hover:bg-secondary/30">
          <TableCell colSpan={5} className="px-4 py-3">
            <ConfirmPanel
              title={`Delete “${formatRulePath(rule.path)}”?`}
              detail="Activity this rule claimed falls through to the next matching rule, or to Uncategorized. Reports recompute from the rules in force, so history changes too — nothing is deleted, but it is relabelled."
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
                    Deleting
                  </>
                ) : (
                  "Delete rule"
                )}
              </Button>
            </ConfirmPanel>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/**
 * Create and edit share one form.
 *
 * Both endpoints take the same body and the same refusals apply, so two forms would be
 * two places for the validation to drift apart. React Hook Form drives it and
 * `ruleFormSchema` resolves it — and that schema calls the real `compileRules`, so a
 * pattern the engine could not run is refused here, in the engine's own words, rather
 * than being stored and silently skipped forever.
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
  const create = useCreateCategoryRule();
  const update = useUpdateCategoryRule();
  const active = ruleId === null ? create : update;

  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RuleDraft>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: initial,
  });

  // The engine judges a rule as a whole, so "needs at least one condition" belongs to
  // the three match fields together rather than to any one of them.
  const conditionsError = errors.root?.["conditions"]?.message;

  return (
    <FormPanel
      title={title}
      description="Every condition you set must match. Patterns are regular expressions, except a bare hostname in Domain, which matches that host and its subdomains."
      onSubmit={handleSubmit((draft) => {
        const input = ruleDraftToInput(draft);
        if (ruleId === null) create.mutate(input, { onSuccess: onDone });
        else update.mutate({ id: ruleId, input }, { onSuccess: onDone });
      })}
    >
      <div className="mt-4">
        <FieldGrid>
          <Field
            label="Category"
            hint="Up to four levels, separated by > or /."
            error={errors.path?.message}
          >
            {(field) => (
              <Input {...field} {...register("path")} placeholder="Work > Development" />
            )}
          </Field>

          <Field label="Classified as" hint="Drives the work-pattern split on every report.">
            {(field) => (
              <Controller
                control={control}
                name="productivity"
                render={({ field: control }) => (
                  <Select
                    value={control.value}
                    onValueChange={(value) => control.onChange(value as Productivity)}
                  >
                    <SelectTrigger {...field}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRODUCTIVITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
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
            label="Application matches"
            hint="Regular expression tested against the application name."
            error={errors.matchApp?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...register("matchApp")}
                className="font-mono"
                placeholder="^(Code|WebStorm)"
              />
            )}
          </Field>

          <Field
            label="Domain matches"
            hint="A bare hostname matches its subdomains too."
            error={errors.matchDomain?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...register("matchDomain")}
                className="font-mono"
                placeholder="github.com"
              />
            )}
          </Field>

          <Field
            label="Window title matches"
            hint="Regular expression tested against the window title."
            error={errors.matchTitle?.message}
          >
            {(field) => (
              <Input {...field} {...register("matchTitle")} className="font-mono" />
            )}
          </Field>

          <Field
            label="Priority"
            hint="Lower runs first. Evaluation stops at the first rule that matches."
            error={errors.priority?.message}
          >
            {(field) => <Input {...field} {...register("priority")} inputMode="numeric" />}
          </Field>
        </FieldGrid>

        <Controller
          control={control}
          name="ignoreCase"
          render={({ field }) => (
            <CheckboxField
              containerClassName="mt-3.5"
              label="Match case exactly"
              checked={!field.value}
              onCheckedChange={(checked) => field.onChange(checked !== true)}
            />
          )}
        />
      </div>

      {conditionsError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {conditionsError}
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
          className="h-9"
          onClick={onCancel}
          disabled={active.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" className="h-9" disabled={active.isPending}>
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
    </FormPanel>
  );
}
