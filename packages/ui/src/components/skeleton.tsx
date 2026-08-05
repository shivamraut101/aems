"use client";

import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Skeleton — the loading placeholder primitive.
 *
 * The dashboard has a well-built skeleton module of its own and then re-invents it
 * inline in seven more files, each with a slightly different pulse and radius. This is
 * the base those should share: one surface colour, one pulse, one radius.
 *
 * Two accessibility points that the inline versions get wrong:
 *
 * - A skeleton is decoration for a region that is already announced as busy. It is
 *   `aria-hidden`, so a screen reader is not read a list of empty boxes. Mark the
 *   region itself `aria-busy` and give it an accessible name.
 * - The pulse is `motion-reduce:animate-none`. A page full of throbbing rectangles is
 *   the single worst offender for motion sensitivity, and the dashboard's globals.css
 *   reduce block collapses it too — this makes the component honest on its own.
 */

const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "animate-skeleton-pulse rounded-md bg-muted motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  ),
);
Skeleton.displayName = "Skeleton";

export interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of lines. */
  lines?: number;
  /** Height of each line. Defaults to the height of a `text-sm` line. */
  lineClassName?: string;
}

/**
 * A block of placeholder text lines. The last line is short, because a paragraph whose
 * final line runs the full width does not read as text.
 */
const SkeletonText = React.forwardRef<HTMLDivElement, SkeletonTextProps>(
  ({ className, lines = 3, lineClassName, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col gap-2", className)} {...props}>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", index === lines - 1 && lines > 1 && "w-2/3", lineClassName)}
        />
      ))}
    </div>
  ),
);
SkeletonText.displayName = "SkeletonText";

export { Skeleton, SkeletonText };
