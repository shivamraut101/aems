"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Checkbox, on Radix.
 *
 * The five raw checkboxes in the dashboard are styled `h-4 w-4 rounded border-input`,
 * which on Windows leaves the box itself drawn by the OS — the check mark ignores the
 * palette and the dark theme entirely. Four of the five also carry a focus ring; the
 * fifth (the "Match case exactly" box in the category rule form) does not, which is the
 * kind of inconsistency that only stops recurring when there is one component.
 *
 * Radix renders a real `<button role="checkbox">` over a hidden native input, so it
 * still submits in a form and still announces its state, while the visible box is ours.
 * Indeterminate is supported because a "select all" header box needs it.
 */

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-input bg-card shadow-sm transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3" aria-hidden strokeWidth={3} />
      ) : (
        <Check className="h-3 w-3" aria-hidden strokeWidth={3} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export interface CheckboxFieldProps
  extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  /** Clickable text beside the box. */
  label: React.ReactNode;
  /** Secondary line under the label. */
  description?: React.ReactNode;
  /** Classes for the wrapping `<label>`, not the box. */
  containerClassName?: string;
}

/**
 * Checkbox with its label, wrapped so the text is part of the hit target.
 *
 * Every checkbox in the dashboard is already inside a `<label>` with hand-written
 * flex/gap classes; this is that arrangement, once.
 */
const CheckboxField = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxFieldProps
>(({ label, description, containerClassName, className, disabled, ...props }, ref) => (
  <label
    className={cn(
      "flex cursor-pointer items-start gap-2 text-sm text-foreground",
      disabled && "cursor-not-allowed opacity-70",
      containerClassName,
    )}
  >
    <Checkbox ref={ref} className={cn("mt-0.5", className)} disabled={disabled} {...props} />
    <span className="min-w-0">
      <span className="block leading-tight">{label}</span>
      {description ? (
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      ) : null}
    </span>
  </label>
));
CheckboxField.displayName = "CheckboxField";

export { Checkbox, CheckboxField };
