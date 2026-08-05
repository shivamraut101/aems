import { KpiRow } from "@/components/kpi-row";
import { Panel, SectionHeading, SkeletonLines } from "@/components/employee/states";

/**
 * What the Overview tab looks like before its own JavaScript has run.
 *
 * The route's Suspense fallback used to be `null`, which is not a neutral choice: the
 * prerendered HTML for the most-visited page in the product contained an empty tab
 * body, so the first paint of `/people/:id` was indistinguishable from a route that
 * had failed — and then the page grew twice, once when `OverviewTab` mounted its own
 * skeleton and again when the day arrived.
 *
 * Structurally identical to `OverviewSkeleton` inside `components/employee/overview-tab.tsx`
 * on purpose: matching the *next* thing the reader will see removes a jump, where
 * matching the final state would only move the jump earlier. The two must stay in
 * step — see the note filed with this work about exporting the original instead of
 * keeping a second copy here.
 */
export function OverviewFallback() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this day</span>
      <KpiRow
        loading
        items={[
          { label: "Work time", value: "" },
          { label: "Active", value: "" },
          { label: "Idle", value: "" },
          { label: "Focused time", value: "" },
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <SectionHeading title="Work pattern" />
          <SkeletonLines count={4} />
        </Panel>
        <Panel>
          <SectionHeading title="Applications" />
          <SkeletonLines count={4} />
        </Panel>
      </div>
    </div>
  );
}
