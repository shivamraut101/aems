/**
 * How much room a table on this app's pages actually has, and how a column set is
 * declared so it never asks for more.
 *
 * This exists because of a measured defect. `/devices` set `min-w-[76rem]` — 1216px —
 * on the flagship inventory table, while a 1280px laptop leaves the page **992px** of
 * content: 1280 minus the 240px sidebar (`w-60`, drawn from `md` up) minus the 48px of
 * `px-6` page padding. So the product's most important table scrolled sideways on an
 * ordinary screen, and did it from the moment it loaded rather than at some extreme.
 *
 * The fix is not a smaller minimum. A 76rem minimum is roughly honest about what
 * eleven columns of hardware inventory *need*; the mistake is showing eleven columns
 * in 992px at all. So a column declares the width at which it starts being drawn, the
 * table's own minimum steps down with it, and the two facts are checked against each
 * other in `table-layout.test.ts` rather than eyeballed in a browser.
 *
 * Two deliberate choices:
 *
 *  - **CSS, not JavaScript.** Columns are gated with Tailwind responsive classes
 *    (`hidden xl:table-cell`), so the server renders exactly what the browser will
 *    keep. Measuring the viewport after mount and re-deciding would put a column-set
 *    change one frame after hydration — which is the same flash the server-prefetch
 *    work exists to remove, just wearing a different hat.
 *  - **Budgets, not measurements.** `budget` is what a column needs to read without
 *    wrapping — a name plus a model line, a badge, "3 minutes ago". It is an input to
 *    the arithmetic, not a rendered width; the table is still `w-full` and shares out
 *    whatever room is left.
 *
 * Placed here rather than in `src/lib/` only because this change owns the two table
 * routes and not that directory. It is general, and belongs next to the other shared
 * view models once someone consolidates.
 */

/** Tailwind's default breakpoints. Nothing in `tailwind-preset.js` overrides them. */
export const BREAKPOINTS = {
  base: 0,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** `w-60` on the sidebar in `app-shell.tsx`. Hidden below `md`, so it costs nothing there. */
export const SIDEBAR_WIDTH = 240;

/**
 * `px-6` on a page container, both sides.
 *
 * Below `sm` the containers are `px-4`, so the real gutter there is 32 and this figure
 * over-charges a phone by 16px. Left at 48 deliberately: every assertion that matters
 * is at `md` and above, where the sidebar exists and the number is exact, and a model
 * that under-states the room a narrow screen has can only fail safe.
 */
export const PAGE_PADDING = 48;

/**
 * The width a page's own content box gets at a given viewport.
 *
 * The step at `md` is abrupt on purpose, because the shell is: at 767px the sidebar is
 * hidden and the page has 719px, and at 768px the sidebar appears and it has 480px.
 * That is the tightest ratio in the app, and it is why the wide columns start at `lg`
 * rather than at `sm` — a set that fits 767px does not fit 768px.
 */
export function contentWidthAt(viewport: number): number {
  const sidebar = viewport >= BREAKPOINTS.md ? SIDEBAR_WIDTH : 0;
  return viewport - sidebar - PAGE_PADDING;
}

export interface ResponsiveColumn {
  /** Matches the TanStack column id, which is what the render loop looks up. */
  id: string;
  /** Header text, and the label in the column picker. */
  label: string;
  /** Smallest viewport at which this column is drawn. */
  from: Breakpoint;
  /**
   * The Tailwind classes implementing {@link from}, written as a literal.
   *
   * A literal because Tailwind's scanner reads source text: a class name assembled at
   * runtime (`` `hidden ${bp}:table-cell` ``) generates no CSS and the column simply
   * never comes back.
   */
  className: string;
  /** What the column needs to read without wrapping, in px. */
  budget: number;
  align?: "right";
}

/** The columns drawn at a viewport width. */
export function columnsAt<T extends ResponsiveColumn>(
  columns: readonly T[],
  viewport: number,
): T[] {
  return columns.filter((column) => viewport >= BREAKPOINTS[column.from]);
}

/** What {@link columnsAt} adds up to — the width the table wants at that viewport. */
export function widthAt(columns: readonly ResponsiveColumn[], viewport: number): number {
  let total = 0;
  for (const column of columnsAt(columns, viewport)) total += column.budget;
  return total;
}

/**
 * A table's declared minimum width, stepping down with its column set.
 *
 * Keyed by viewport rather than by breakpoint name so the test can read it with the
 * same number it feeds {@link contentWidthAt}. The `className` alongside is the string
 * actually rendered; keeping them in one object is what stops the arithmetic proving
 * something the markup does not do.
 */
export interface TableMinWidth {
  /** Tailwind `min-w-[…]` classes, responsive, as a literal. */
  className: string;
  /** The same thresholds in px: viewport → minimum table width. */
  px: ReadonlyArray<readonly [viewport: number, minWidth: number]>;
}

/** The minimum in force at a viewport — the last threshold it has reached. */
export function minWidthAt(minimum: TableMinWidth, viewport: number): number {
  let current = 0;
  for (const [threshold, width] of minimum.px) {
    if (viewport >= threshold) current = width;
  }
  return current;
}
