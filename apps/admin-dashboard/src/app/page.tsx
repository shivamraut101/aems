"use client";

import { AiInsight } from "@/components/ai-insight";
import { KpiRow } from "@/components/kpi-row";
import { LiveWorkforce } from "@/components/live-workforce";
import { useOverview } from "@/lib/api";
import { greeting, longDate } from "@/lib/format";

/**
 * Dashboard home.
 *
 * Answers one question — "how is my company doing today?" — in the order a manager
 * actually asks it: the numbers, then who is working, then what it means.
 */
export default function OverviewPage() {
  const { data, isLoading } = useOverview();

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">{greeting()}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{longDate()}</p>
      </header>

      <KpiRow
        loading={isLoading}
        items={[
          { label: "Employees", value: String(data?.totalEmployees ?? 0) },
          { label: "Active now", value: String(data?.activeNow ?? 0) },
          { label: "Working today", value: String(data?.workingToday ?? 0) },
          { label: "Hours tracked", value: `${data?.totalHoursToday ?? 0}h` },
        ]}
      />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold tracking-tight">Live workforce</h2>
        <LiveWorkforce />
      </section>

      <div className="mt-8">
        <AiInsight
          summary="Daily summaries appear here once the AI summary worker has run for the first time."
          observation="Deploy supabase/functions/ai-summary and schedule it to enable this panel."
        />
      </div>
    </div>
  );
}
