"use client";

import { Slot } from "@radix-ui/react-slot";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Tabs.
 *
 * Two things live here, because the dashboard has two different problems that both
 * look like tabs, and using the wrong one is an accessibility bug rather than a style
 * choice.
 *
 * **`Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`** — Radix. Use when the panels
 * are on the page and switching between them changes nothing else: same URL, no fetch,
 * no history entry. Radix owns the roving focus, `aria-controls`, and the
 * arrow/Home/End keys.
 *
 * **`NavTabs` / `NavTabsItem`** — use when each tab is a *route*. The employee page's
 * seven-tab strip is link-based over nested routes and must stay that way, and Radix
 * Tabs is the wrong primitive for it: `TabsTrigger` emits `role="tab"` with
 * `aria-controls` pointing at a `TabsContent` that does not exist, and roving focus
 * takes the links out of the natural tab order for no gain. The correct markup for a
 * set of links is a `<nav>` of anchors with `aria-current="page"` on the active one —
 * which is what this renders, with the same visual treatment so the two read alike.
 * It also replaces the hand-written ArrowLeft/ArrowRight/Home/End handler in that file,
 * which was reimplementing a keyboard pattern links are not supposed to have.
 *
 * Both strips scroll horizontally rather than wrapping — seven tabs do not fit on a
 * 375px screen, and a wrapped tab strip stops looking like one.
 */

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "flex w-full items-center gap-1 overflow-x-auto border-b",
      // Underline tabs, not the pill group: docs/design.md rules out huge rounded
      // shapes, and an underline reads as navigation rather than as a segmented button.
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

/** Shared between the Radix trigger and the link variant so the two cannot drift. */
const tabItemClasses = cn(
  "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md",
  "border-b-2 border-transparent px-3 py-2 text-sm font-medium transition-colors",
  "text-muted-foreground hover:text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "disabled:pointer-events-none disabled:opacity-50",
);

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      tabItemClasses,
      "-mb-px",
      "data-[state=active]:border-primary data-[state=active]:text-foreground",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-4 focus-visible:outline-none", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export interface NavTabsProps extends React.HTMLAttributes<HTMLElement> {
  /** Accessible name for the group, e.g. "Employee sections". */
  label: string;
}

/** Route-driven tab strip: a `<nav>` of links, not a `role="tablist"`. */
const NavTabs = React.forwardRef<HTMLElement, NavTabsProps>(
  ({ className, label, children, ...props }, ref) => (
    <nav ref={ref} aria-label={label} className={cn("border-b", className)} {...props}>
      <ul className="flex items-center gap-1 overflow-x-auto">{children}</ul>
    </nav>
  ),
);
NavTabs.displayName = "NavTabs";

export interface NavTabsItemProps extends React.LiHTMLAttributes<HTMLLIElement> {
  /** True on the tab matching the current route. Sets `aria-current="page"`. */
  active?: boolean;
  /**
   * The link. Rendered through Slot, so pass the router's own component — a Next
   * `<Link>` — and it keeps client-side navigation and prefetching.
   */
  children: React.ReactElement;
}

const NavTabsItem = React.forwardRef<HTMLLIElement, NavTabsItemProps>(
  ({ className, active = false, children, ...props }, ref) => (
    <li ref={ref} className={cn("shrink-0", className)} {...props}>
      <Slot
        aria-current={active ? "page" : undefined}
        className={cn(
          tabItemClasses,
          "-mb-px",
          active && "border-primary text-foreground",
        )}
      >
        {children}
      </Slot>
    </li>
  ),
);
NavTabsItem.displayName = "NavTabsItem";

export { NavTabs, NavTabsItem, Tabs, TabsContent, TabsList, TabsTrigger };
