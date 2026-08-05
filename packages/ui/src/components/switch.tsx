"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Switch, on Radix.
 *
 * For settings that take effect the moment they are flipped — "monitoring enabled" on a
 * person, the per-signal collection toggles in settings. A checkbox says "this will be
 * true when you submit"; a switch says "this is on now". The dashboard currently
 * expresses monitoring state as a two-option `<select>`, which reads as neither.
 *
 * Checked is `--primary` (navy in light, near-white in dark) rather than
 * `--accent`: indigo is reserved for AI surfaces by `docs/design.md`, and a toggle
 * flashing it would claim model involvement in a plain configuration change.
 *
 * The thumb translation is a transform transition, disabled under reduced motion. There
 * is no state Radix does not already hold, so nothing here is reimplemented.
 */

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "transition-colors motion-reduce:transition-none",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/40",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-card shadow ring-0",
        "transition-transform motion-reduce:transition-none",
        "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export interface SwitchFieldProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Classes for the row, not the switch. */
  containerClassName?: string;
}

/**
 * Switch with its label on the left and the control right-aligned — the settings-row
 * arrangement, where the eye scans a column of labels and a column of states.
 *
 * `htmlFor` is not usable here: Radix renders a `<button>`, and a `<label for>` pointing
 * at a button is ignored by browsers. The label is associated by `aria-labelledby`
 * instead, which is what actually gets announced.
 */
const SwitchField = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchFieldProps>(
  ({ label, description, containerClassName, className, id, ...props }, ref) => {
    const reactId = React.useId();
    const switchId = id ?? `${reactId}-switch`;
    const labelId = `${reactId}-label`;
    const descriptionId = description ? `${reactId}-description` : undefined;

    return (
      <div className={cn("flex items-start justify-between gap-4", containerClassName)}>
        <span className="min-w-0">
          <span id={labelId} className="block text-sm font-medium leading-tight text-foreground">
            {label}
          </span>
          {description ? (
            <span id={descriptionId} className="mt-0.5 block text-xs text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <Switch
          ref={ref}
          id={switchId}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className={cn("mt-0.5", className)}
          {...props}
        />
      </div>
    );
  },
);
SwitchField.displayName = "SwitchField";

export { Switch, SwitchField };
