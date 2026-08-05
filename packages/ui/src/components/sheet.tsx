"use client";

import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Sheet — an edge-anchored drawer, on Radix Dialog.
 *
 * The reason this exists: `AppShell` renders its navigation as
 * `hidden w-60 shrink-0 flex-col … md:flex`, and there is no alternative anywhere in
 * the app. Below 768px a user gets no navigation, no home link, and — because the
 * session card and the sign-out button live inside that same hidden `<nav>` — no way
 * to sign out. Changing section requires editing the URL. A drawer behind a menu button
 * is the fix, and a drawer is a modal dialog with a different entrance.
 *
 * Everything modal about it is Radix Dialog's: the focus trap, the Escape handler, the
 * inert background, the scroll lock, focus returning to the button that opened it.
 * Only the position and the entrance are ours.
 *
 * `SheetTitle` is not optional. Radix warns without one, and a navigation drawer that
 * announces nothing on open is a screen-reader dead end — use `className="sr-only"` if
 * the title should not be visible.
 */

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    ref={ref}
    className={cn(
      // Matches DialogOverlay exactly. No backdrop blur: docs/design.md rules out
      // glassmorphism, and one scrim treatment across the product is the point.
      "fixed inset-0 z-50 bg-background/80",
      "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
      "motion-reduce:animate-none",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  cn(
    "fixed z-50 flex flex-col gap-4 border bg-card p-5 shadow-lg outline-none",
    // A drawer taller than the window scrolls itself; the page behind it is already
    // locked by Radix, so this is the only scroller.
    "overflow-y-auto",
    "motion-reduce:animate-none",
  ),
  {
    variants: {
      side: {
        // `w-[17rem]` with a `max-w` guard: 272px leaves the scrim visible at 320px, so
        // the drawer never reads as a full-screen page the user cannot get out of.
        left: cn(
          "inset-y-0 left-0 h-full w-[17rem] max-w-[calc(100vw-3rem)] border-y-0 border-l-0",
          "data-[state=open]:animate-slide-in-left data-[state=closed]:animate-slide-out-left",
        ),
        right: cn(
          "inset-y-0 right-0 h-full w-[17rem] max-w-[calc(100vw-3rem)] border-y-0 border-r-0",
          "data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right",
        ),
        top: cn(
          "inset-x-0 top-0 max-h-[calc(100vh-3rem)] border-x-0 border-t-0",
          "data-[state=open]:animate-slide-in-top data-[state=closed]:animate-slide-out-top",
        ),
        bottom: cn(
          "inset-x-0 bottom-0 max-h-[calc(100vh-3rem)] border-x-0 border-b-0",
          "data-[state=open]:animate-slide-in-bottom data-[state=closed]:animate-slide-out-bottom",
        ),
      },
    },
    defaultVariants: {
      side: "left",
    },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "left", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side }), className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close
        className={cn(
          "absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-md border",
          "text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none",
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = SheetPrimitive.Content.displayName;

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // `pr-9` keeps the title clear of the close button pinned in the corner.
  return <div className={cn("flex flex-col gap-1.5 pr-9", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mt-auto flex flex-col gap-2 pt-4", className)} {...props} />
  );
}

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold tracking-tight", className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
  sheetVariants,
};
