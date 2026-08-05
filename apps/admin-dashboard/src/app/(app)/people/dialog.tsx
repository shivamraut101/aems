"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

/**
 * The modal shell the two People dialogs share.
 *
 * `docs/design.md` asks for a dialog or an inline panel rather than a new page for
 * management actions, and there is no dialog primitive in `packages/ui` — so this is
 * the primitive, written once here rather than twice inside the two screens that need
 * it. It is deliberately plain: a thin border, an 8px radius and a flat scrim. No
 * backdrop blur, because the design document rules out glassmorphism.
 *
 * The three behaviours that make a modal a modal, and that a bare absolutely
 * positioned `<div>` silently omits:
 *
 *  - **Escape closes it.** Every other dismissal on this page is a mouse target.
 *  - **Tab is trapped.** Without the trap, focus walks out into the roster behind the
 *    scrim, and for anyone driving by keyboard or screen reader the dialog quietly
 *    stops existing while still covering the page.
 *  - **Focus returns.** The element that opened the dialog is focused again on close,
 *    so a keyboard user is put back where they were instead of at the top of the body.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  labelledBy,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Overrides the generated id when the caller renders its own heading. */
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const headingId = useId();
  const descriptionId = useId();

  useEffect(() => {
    openerRef.current = document.activeElement;

    // Focus the panel rather than the first field: a screen reader then announces the
    // dialog's own name and purpose before it starts reading a text input's label.
    panelRef.current?.focus();

    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 sm:items-center"
      onMouseDown={(event) => {
        // `mousedown` on the scrim itself, not `click`: a click whose press began
        // inside the panel and whose release landed outside it is a text selection
        // that ran off the edge, and closing on it discards a half-typed form.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? headingId}
        {...(description ? { "aria-describedby": descriptionId } : {})}
        tabIndex={-1}
        className="my-auto w-full max-w-lg rounded-lg border bg-card shadow-lg focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={headingId} className="text-sm font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/* ------------------------------------------------------------------------- */
/* Form furniture                                                             */
/* ------------------------------------------------------------------------- */

/**
 * One labelled control with its error underneath.
 *
 * The error is wired through `aria-describedby` and `aria-invalid` rather than only
 * being painted red, so the reason a field was rejected is announced rather than
 * merely visible.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const controlClass =
  "mt-1 h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive";

export const primaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

export const destructiveButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The API's own words, verbatim.
 *
 * `describeError` already turns a status into a sentence and keeps the server's
 * message for the statuses where it is the only thing that knows why — a duplicate
 * email, a role the company may not assign. Rendering a generic "Something went
 * wrong" over the top of that is how an actionable refusal becomes a mystery.
 */
export function FormError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
    >
      {message}
    </p>
  );
}
