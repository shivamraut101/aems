"use client";

import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Separator, on Radix.
 *
 * Most dividers in the product are a `border-b` or a `divide-y` on a list, and those
 * should stay as they are — a border between two rows is decoration, and adding an
 * element for it only adds noise to the accessibility tree.
 *
 * This is for the other case: a rule that separates two *groups* whose boundary is not
 * otherwise conveyed, such as the sections of the mobile navigation drawer. Radix
 * defaults it to `decorative`, which renders `role="none"`; pass `decorative={false}`
 * to emit a real `role="separator"` when the division carries meaning.
 */

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
