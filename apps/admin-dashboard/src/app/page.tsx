"use client";

import { useEffect, useState } from "react";

import { AiInsight } from "@/components/ai-insight";
import { KpiRow } from "@/components/kpi-row";
import { LiveWorkforce } from "@/components/live-workforce";
import { useOverview } from "@/lib/api";
import { greeting, longDate } from "@/lib/format";

/**
 * The viewer's own clock, available only after mount.
 *
 * `greeting()` reads the local hour and `longDate()` the local timezone AND locale.
 * A "use client" component is still server-rendered for the first paint, and the
 * server knows neither: it produced "Good afternoon"/"Wednesday 5 August" in the
 * server's zone while the browser produced its own, and React threw a hydration
 * mismatch on this page.
 *
 * Deferring is the fix rather than `suppressHydrationWarning`, which only silences
 * the warning and KEEPS the server's text — so a server an ocean away would wish a
 * user good morning at 9pm. In a product about when people work, that is not a
 * detail worth trading for one frame.
 */
function useLocalNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  return now;
}

/**
 * Dashboard home.
 *
 * Answers one question — "how is my company doing today?" — in the order a manager
 * actually asks it: the numbers, then who is working, then what it means.
 */
export default function OverviewPage() {
  const { data, isLoading } = useOverview();
  const now = useLocalNow();

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <header className="mb-6">
        {/* Non-breaking spaces hold both lines' height for the one frame before the
            local clock is known, so the page does not jump as it settles. */}
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">
          {now ? greeting(now) : " "}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{now ? longDate(now) : " "}</p>
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

      <section className="mt-9">
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Live workforce
        </h2>
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
