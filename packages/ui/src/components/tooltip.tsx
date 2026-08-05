"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Tooltip, on Radix.
 *
 * The dashboard explains things with the native `title` attribute in half a dozen
 * places — the multi-display capture count, the disabled "deactivate yourself" button,
 * the timeline segments, the truncated emails in the session card and the employee
 * header. A `title` never appears on touch, never appears on keyboard focus, and cannot
 * be styled, so on a phone that explanation simply does not exist. Radix shows on hover
 * *and* focus and announces through `aria-describedby`.
 *
 * Two rules for callers:
 *
 * 1. A tooltip is supplementary. If the text is the only way to know what a control
 *    does, it belongs in an `aria-label` or visible text, not here.
 * 2. `TooltipProvider` goes once near the root of the app, not around each tooltip —
 *    it is what makes the second tooltip in a row open without its own delay.
 */

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipPortal = TooltipPrimitive.Portal;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        // Inverted against the surface so it reads as an overlay rather than as another
        // panel: `--primary` is navy on light and near-white on dark, and its
        // foreground token follows, so the pair is legible in both themes.
        "z-50 max-w-xs rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground shadow-md",
        "data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in",
        "data-[state=closed]:animate-fade-out",
        "motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipPortal, TooltipProvider, TooltipTrigger };
