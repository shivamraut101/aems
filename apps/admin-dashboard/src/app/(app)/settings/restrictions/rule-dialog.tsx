"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
  Textarea,
} from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Controller, useForm } from "react-hook-form";

import { describeError } from "@/lib/api";
import {
  DEFAULT_RULE_PRIORITY,
  MAX_NOTE_LENGTH,
  canonicalDomain,
  duplicateRule,
  emptyRestrictionRule,
  modeCopy,
  patternCaution,
  restrictionRuleFormFrom,
  restrictionRuleSchema,
  restrictionRuleToInput,
  useCreateRestrictionRule,
  useUpdateRestrictionRule,
  type RestrictionMode,
  type RestrictionRule,
  type RestrictionRuleForm,
} from "@/lib/queries/restrictions";

/**
 * Add or edit one website rule.
 *
 * A dialog rather than an inline row, because a rule has six decisions in it and a table
 * row that expands into a six-field form stops being a table. Both actions share one
 * component: `POST /rules` and `PATCH /rules/:id` take the same body and apply the same
 * refusals, so two forms would be two places for the validation to drift.
 *
 * React Hook Form + Zod per `CLAUDE.md`, with `restrictionRuleSchema` as the single
 * source of validation truth. What the schema cannot know is checked here instead: a
 * duplicate is a fact about the *other* rules, which is data the schema does not hold.
 *
 * The server still gets the last word, and that is deliberate. The API validates a
 * pattern by *compiling* it with the same matcher the extension runs, which is a stronger
 * check than any regex here could be — so this form refuses only the mistakes it can
 * explain, and `describeError` renders the API's own sentence for everything else. A
 * generic "something went wrong" on a form like this is what makes a product feel broken.
 */
export function RuleDialog({
  mode,
  rule,
  rules,
  onClose,
}: {
  mode: RestrictionMode;
  /** Null to create. */
  rule: RestrictionRule | null;
  /** The rules already in the policy, for the duplicate check. */
  rules: readonly RestrictionRule[];
  onClose: () => void;
}) {
  const create = useCreateRestrictionRule();
  const update = useUpdateRestrictionRule();
  const active = rule === null ? create : update;

  const {
    register,
    control,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<RestrictionRuleForm>({
    resolver: zodResolver(restrictionRuleSchema),
    defaultValues: rule ? restrictionRuleFormFrom(rule) : emptyRestrictionRule(mode),
  });

  const matchKind = watch("matchKind");
  const action = watch("action");
  const typedPattern = watch("pattern");
  const canonical = matchKind === "domain" ? canonicalDomain(typedPattern) : null;
  // Legal, compiles, matches nothing — the one mistake this form can see and the API
  // cannot. A caution rather than an error, because `intranet` is a real host.
  const caution = errors.pattern ? null : patternCaution(matchKind, typedPattern);
  const noteLength = watch("note").trim().length;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit website rule" : "Add a website rule"}</DialogTitle>
          <DialogDescription>
            {modeCopy(mode).summary} A rule here is the exception to that.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((values) => {
            const clash = duplicateRule(rules, values, rule?.id ?? null);
            if (clash) {
              setError("pattern", {
                message: `A rule for ${clash.pattern} already exists${clash.note ? ` (“${clash.note}”)` : ""}. Edit that one instead — the API refuses a second rule for the same pattern.`,
              });
              return;
            }

            const input = restrictionRuleToInput(values);
            if (rule === null) create.mutate(input, { onSuccess: onClose });
            else update.mutate({ id: rule.id, input }, { onSuccess: onClose });
          })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="What it matches"
              hint={
                matchKind === "domain"
                  ? "A whole site, including every subdomain of it."
                  : "One address or a family of them, with * as the only wildcard."
              }
              error={errors.matchKind?.message}
            >
              {(field) => (
                <Controller
                  control={control}
                  name="matchKind"
                  render={({ field: kind }) => (
                    <Select value={kind.value} onValueChange={kind.onChange}>
                      <SelectTrigger {...field}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="domain">Whole website</SelectItem>
                        <SelectItem value="url_pattern">URL pattern</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field
              label="What it does"
              hint={
                action === "block"
                  ? "Pages this rule matches are refused."
                  : "Pages this rule matches are allowed, even if a broader rule would refuse them."
              }
              error={errors.action?.message}
            >
              {(field) => (
                <Controller
                  control={control}
                  name="action"
                  render={({ field: choice }) => (
                    <Select value={choice.value} onValueChange={choice.onChange}>
                      <SelectTrigger {...field}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="block">Block</SelectItem>
                        <SelectItem value="allow">Allow</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          </div>

          <Field
            label={matchKind === "domain" ? "Website" : "URL pattern"}
            required
            hint={
              // Confirms the reduction as it is typed. Someone pasting a full URL needs to
              // see that a website rule is about the host, not the page they copied.
              canonical && canonical !== typedPattern.trim().toLowerCase()
                ? `Saved as ${canonical}`
                : matchKind === "domain"
                  ? "The domain on its own — facebook.com, not a full web address."
                  : "For example example.com/admin* or *.ads.example.com. * is the only wildcard."
            }
            error={errors.pattern?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...register("pattern")}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                placeholder={matchKind === "domain" ? "facebook.com" : "example.com/admin*"}
                className="font-mono"
              />
            )}
          </Field>

          {caution ? (
            <p className="-mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0">{caution}</span>
            </p>
          ) : null}

          <Field
            label="Reason employees see"
            hint={`Shown on the refused page on top of the company-wide message, so nobody has to guess or ask around. ${String(MAX_NOTE_LENGTH - noteLength)} characters left.`}
            error={errors.note?.message}
          >
            {(field) => (
              <Textarea
                {...field}
                {...register("note")}
                rows={2}
                placeholder="Not part of company work. Ask your manager if you need access for a task."
              />
            )}
          </Field>

          <Field
            label="Order"
            hint={`The lowest number that matches decides, so an exception needs a lower number than the rule it narrows. ${String(DEFAULT_RULE_PRIORITY)} is the default.`}
            error={errors.priority?.message}
          >
            {(field) => (
              <Input
                {...field}
                {...register("priority", { valueAsNumber: true })}
                type="number"
                min={0}
                max={100000}
                step={1}
                inputMode="numeric"
                className="sm:w-32"
              />
            )}
          </Field>

          <Controller
            control={control}
            name="enabled"
            render={({ field }) => (
              <SwitchField
                containerClassName="rounded-md border px-3 py-2.5"
                label="Rule is active"
                description="Turn this off to park the rule without deleting it — useful for trying a change and putting it back."
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />

          {active.isError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
            >
              {describeError(active.error)}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={active.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={active.isPending}>
              {active.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {rule ? "Save rule" : "Add rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
