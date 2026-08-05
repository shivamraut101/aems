"use client";

import { cn } from "@aems/ui";

/**
 * The frame every screen in the personal section is drawn in — /me, /my-devices,
 * /account.
 *
 * ## There is deliberately no tab strip here
 *
 * An earlier draft repeated the three destinations as a strip under the heading,
 * because `NAV` in `lib/session.ts` then offered an employee exactly one. It now
 * carries all three as the sidebar's `personal` group, and the mobile drawer renders
 * that same group — so a strip would be a second copy of a navigation already on the
 * screen. Two copies is not merely noise: both would mark the current page, and two
 * `aria-current="page"` elements in one document tell a screen reader the reader is in
 * two places at once.
 *
 * What replaces it is contextual rather than structural: /me and /account each link to
 * the specific thing the reader is likely to want next ("My devices and consent"),
 * which says why to go rather than only where.
 *
 * ## 375px
 *
 * `max-w-5xl` with a 16px gutter on a phone: these screens are prose and definition
 * lists rather than dense tables, and prose at full desktop width is unreadable.
 */
export function MeShell({
  title,
  subtitle,
  control,
  children,
}: {
  title: string;
  subtitle: string;
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-7">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {control}
      </header>

      <div className="space-y-5">{children}</div>
    </div>
  );
}

/**
 * A bordered section. 8px radius, thin border, no shadow stack, no gradient.
 *
 * Deliberately not `@aems/ui`'s `Card`, which is `rounded-xl` with 24px padding and a
 * shadow — the "huge rounded card" `docs/design.md` rules out. This matches the panels
 * the rest of the dashboard already draws.
 */
export function MePanel({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/**
 * A label/value pair.
 *
 * Stacked on a phone and two-column from `sm` up, because a 96px label column beside a
 * long department name wraps into an unreadable ladder at 375px.
 */
export function Fact({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-x-4">
      <dt className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="min-w-0 text-sm">
        {children}
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </dd>
    </div>
  );
}

/** The container `Fact` rows sit in. */
export function FactList({ children }: { children: React.ReactNode }) {
  return <dl className="grid gap-3">{children}</dl>;
}
