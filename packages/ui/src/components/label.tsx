"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Label, on Radix.
 *
 * `@radix-ui/react-label` was already a dependency here with nothing wrapping it. It
 * earns its place over a bare `<label>` by swallowing the double-click text selection
 * a label triggers on its control, and by forwarding the click to the associated
 * element even when that element is a custom control rather than a native input —
 * which is what `Checkbox`, `Switch` and `Select` are.
 *
 * `docs/design.md` puts labels at weight 500.
 *
 * `peer-disabled:` is included so a label dims with the control it names, but that only
 * fires when the control is a *previous sibling* marked `peer`. The reliable pairing is
 * `<Field>` below, which does not depend on DOM order.
 */

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none text-foreground",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

/**
 * The uppercase micro-label used for table headers, KPI captions and filter captions.
 * Written out inline in a dozen places at three slightly different tracking values.
 */
const FieldLabel = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
FieldLabel.displayName = "FieldLabel";

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Visible label text. */
  label: React.ReactNode;
  /** Rendered under the control; announced through `aria-describedby`. */
  hint?: React.ReactNode;
  /** Validation message. Takes the place of `hint` and marks the control invalid. */
  error?: React.ReactNode;
  /** Appends a "required" marker with a text equivalent for screen readers. */
  required?: boolean;
  /**
   * Receives `id`, `aria-describedby` and `aria-invalid`. Spread them onto the control
   * so the wiring cannot be forgotten — three hand-rolled `Field` wrappers exist in the
   * dashboard and two of them label with a bare `<label>` carrying no `htmlFor` at all.
   */
  children: (controlProps: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
  }) => React.ReactNode;
}

/**
 * Label + control + hint/error, with the accessibility wiring done once.
 *
 * ```tsx
 * <Field label="Department" error={errors.department?.message}>
 *   {(field) => <Input {...field} {...register("department")} />}
 * </Field>
 * ```
 */
function Field({ label, hint, error, required, children, className, ...props }: FieldProps) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const describedBy = error || hint ? hintId : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)} {...props}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <>
            <span aria-hidden className="ml-0.5 text-destructive">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </Label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {error ? (
        <p id={hintId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export { Field, FieldLabel, Label };
