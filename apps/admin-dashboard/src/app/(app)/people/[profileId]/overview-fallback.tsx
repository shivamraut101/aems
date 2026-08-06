import { OverviewSkeleton } from "@/components/employee/overview-tab";

/**
 * What the Overview tab looks like before its own JavaScript has run.
 *
 * The route's Suspense fallback used to be `null`, which is not a neutral choice: the
 * prerendered HTML for the most-visited page in the product contained an empty tab
 * body, so the first paint of `/people/:id` was indistinguishable from a route that
 * had failed — and then the page grew twice, once when `OverviewTab` mounted its own
 * skeleton and again when the day arrived.
 *
 * It is now `OverviewTab`'s own skeleton rather than a second copy of it. Matching the
 * *next* thing the reader will see is what removes the jump, and a hand-maintained
 * copy matches only until somebody edits one of the two — which is what the note filed
 * with the original asked for, and what adding the verdict block above the figures
 * would have broken on its first day.
 */
export function OverviewFallback() {
  return <OverviewSkeleton />;
}
