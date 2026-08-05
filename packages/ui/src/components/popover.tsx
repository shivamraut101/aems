"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Popover, on Radix.
 *
 * This is the replacement for the range picker's hand-rolled panel, which carries a
 * `role="dialog"` div plus its own Escape handler, its own outside-click detection via
 * `onPointerDown` and `panelRef.contains(target)`, its own `document.addEventListener`
 * pair with matching cleanup, and its own focus restoration to the trigger. All four
 * behaviours are Radix's, and the hand-rolled version still misses the fifth: it is
 * anchored `right-0` at a fixed 304px width with no collision handling, so on a narrow
 * container it runs off the edge of the viewport.
 *
 * `collisionPadding` and the `--radix-popover-content-available-*` variables are what
 * make it flip and shrink instead. That is the whole reason to adopt the primitive.
 */

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;
const PopoverPortal = PopoverPrimitive.Portal;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "end", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={12}
      className={cn(
        "z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none",
        // Never wider or taller than the room it has — the fixed-width hand-rolled
        // panel is exactly what overflows a phone.
        "max-w-[var(--radix-popover-content-available-width)]",
        "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto",
        "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
        "motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverPortal, PopoverTrigger };
