import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-muted-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",

        /*
         * Status, through the tokens rather than the Tailwind palette.
         *
         * These read `emerald-500/15` and `zinc-500/15` before, which is why one
         * screen could show a different green from the next and why dark mode
         * inherited tints mixed for a white page. `success-muted` and friends are
         * tuned per theme in globals.css, so both grounds are decided in one file.
         */
        success: "border-transparent bg-success-muted text-success",
        warning: "border-transparent bg-warning-muted text-warning",
        /* Indigo, and therefore for model output only — never a status. */
        ai: "border-transparent bg-accent-muted text-accent",

        /* Presence. Kept as names because the tables read better for them. */
        online: "border-transparent bg-success-muted text-success",
        offline: "border-transparent bg-secondary text-muted-foreground",
        revoked: "border-transparent bg-destructive-muted text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * Draws the leading dot that separates a *state* from a *label*.
   *
   * "Active" is something the person is doing right now; "Developer" is something
   * they are. Both are pills, and without the dot a reader has to know the
   * vocabulary to tell which kind they are looking at.
   */
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </div>
  );
}

export { badgeVariants };
