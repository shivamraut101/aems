"use client";

import { Search } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils.js";

/**
 * Input.
 *
 * The dashboard carries thirty raw `<input>` elements hand-styled by seven competing
 * class strings (`controlClass` in two places, `selectClass` in two more, `fieldClass`,
 * `dateFieldClass`, and a `fieldClass()` function in the login form). They disagree on
 * padding, on disabled opacity and on whether there is a transition. This is the one
 * definition; the differences were drift, not intent.
 *
 * Height matches `SelectTrigger` (`h-9`) so a filter bar mixing the two sits on one
 * baseline, and the focus ring is the same `ring-2 ring-ring` every other control uses.
 *
 * Two native input types need help, and both appear throughout the app:
 *
 * - `type="date"` — Chrome draws the calendar-picker indicator as a dark glyph with no
 *   regard for the theme, so it disappears against the dark palette. `invert` under
 *   `.dark` restores it. There are seven date inputs in the dashboard.
 * - `type="search"` — WebKit's built-in cancel button is unstyleable and sits at a
 *   different inset from our own controls; it is removed in favour of the caller's own
 *   clear affordance.
 */

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground shadow-sm",
        "transition-colors placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        // Native date/time pickers: keep the indicator legible in both themes.
        "[&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60",
        "hover:[&::-webkit-calendar-picker-indicator]:opacity-100",
        "dark:[&::-webkit-calendar-picker-indicator]:invert",
        // Native search affordances, replaced by ours.
        "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export interface SearchInputProps extends InputProps {
  /** Classes for the positioning wrapper — width lives here, not on the input. */
  containerClassName?: string;
}

/**
 * Search input with its leading magnifier.
 *
 * The icon-inside-a-relative-wrapper pattern is written out by hand on the devices
 * page, the people page and the settings monitoring section, each with its own inset.
 * The icon is `aria-hidden` — it decorates a control that must still carry a real
 * accessible name, so callers pass `aria-label` or wire a `<Label htmlFor>`.
 *
 * `w-full` by default with the width set on the wrapper: the hand-rolled versions used
 * a fixed `w-72` with no `max-w-full`, which is why the filter bars overflow at 375px.
 */
const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, containerClassName, ...props }, ref) => (
    <div className={cn("relative w-full", containerClassName)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input ref={ref} type="search" className={cn("pl-8", className)} {...props} />
    </div>
  ),
);
SearchInput.displayName = "SearchInput";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multi-line counterpart, sharing the border, ring and disabled treatment. */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-sm",
        "transition-colors placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Input, SearchInput, Textarea };
