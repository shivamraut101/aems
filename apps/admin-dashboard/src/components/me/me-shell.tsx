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
 * ## Width
 *
 * `max-w-6xl` and the same gutters as `overview-view.tsx`, so moving between Overview
 * and this section does not resize the page under the reader. The prose-width argument
 * that once made this `max-w-5xl` is answered where it actually applies — every
 * paragraph below carries `max-w-prose` — rather than by narrowing panels and tables
 * that are not prose.
 *
 * At 375px it is a 16px gutter and nothing else.
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
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-7">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
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
    <section className={cn("rounded-lg border bg-card shadow-[var(--shadow-sm)]", className)}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {/* 13px, matching `Panel` in overview-view.tsx — a panel heading is a label
                for the block, not a heading in the page's type scale. */}
            <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
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
      {/* `break-words` on the value, once: a company name, a CPU model or a device label
          is arbitrary text, and one long token here is the whole page's horizontal
          overflow at 390px. */}
      <dd className="min-w-0 break-words text-sm">
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
