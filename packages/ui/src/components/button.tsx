import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils.js";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
    // Transform joins the transition so the press below eases rather than snaps.
    "transition-[color,background-color,border-color,transform] duration-150",
    /*
     * `ring-2`, not shadcn's stock `ring-1`.
     *
     * Every other focusable thing in this product — nav items, table links, the
     * filter chips, the sign-out control — rings at 2. A button ringing at 1 meant
     * the focus indicator got *thinner* as a keyboard user tabbed onto the most
     * important control on the screen, which is the wrong way round.
     */
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    /*
     * Press feedback.
     *
     * A button that looks identical the instant it is clicked gives a reader nothing
     * to tell a registered press from a missed one, so they click again — the same
     * complaint that produced the navigation skeletons, one layer down. Two percent
     * is deliberately below the threshold anyone would call an animation:
     * docs/design.md rules out heavy motion, and this is meant to be felt rather
     * than watched. `prefers-reduced-motion` collapses the duration globally in
     * globals.css, so it becomes instant rather than absent — the acknowledgement
     * survives, the movement does not.
     */
    "active:scale-[0.98]",
    "disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        // `hover:bg-secondary`, not shadcn's default `hover:bg-accent`: `--accent` is
        // the indigo docs/design.md reserves for AI surfaces, so the stock variants
        // flashed "this is model output" on every ordinary button in the product.
        outline:
          "border border-input bg-background shadow-sm hover:bg-secondary hover:text-secondary-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-secondary hover:text-secondary-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  ),
);

Button.displayName = "Button";

export { buttonVariants };
