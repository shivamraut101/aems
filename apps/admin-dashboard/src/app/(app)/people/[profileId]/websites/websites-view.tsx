"use client";

import { Info } from "lucide-react";
import { Suspense, useMemo } from "react";

import { devicesQuery } from "@/components/employee/employee-queries";
import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
  TruncationNotice,
} from "@/components/employee/states";
import { UsageTable, busiestRow } from "@/components/employee/usage-table";
import { useDayWindow } from "@/components/employee/use-day-window";
import { describeError, useApiQuery } from "@/lib/api";
import { duration } from "@/lib/format";
import {
  cellOf,
  devicesForProfile,
  sectionOf,
  tableColumns,
  useWebsiteUsage,
  websiteCoverage,
  type CoverageLevel,
  type ReportRow,
} from "@/lib/queries/usage";

/**
 * Websites tab — scope §2.5.
 *
 * The one screen whose completeness depends on the machine rather than on the day. The
 * agent reads a real address from the browser on macOS; on Windows there is no supported
 * way to read a tab's address from outside the browser, so unless the managed AEMS
 * extension is connected it records only a domain the window title spells out and
 * refuses to guess. That gap is stated on the page rather than left to be discovered as
 * a bug — a short list here is a platform limit, not an absence of work, and an empty
 * one says so in its own title.
 */
export function WebsitesTabView({ profileId }: { profileId: string }) {
  return (
    <Suspense fallback={<LoadingPanel />}>
      <WebsitesTab profileId={profileId} />
    </Suspense>
  );
}

function WebsitesTab({ profileId }: { profileId: string }) {
  const day = useDayWindow();
  const range = useMemo(() => ({ from: day?.from ?? "", to: day?.to ?? "" }), [day?.from, day?.to]);

  const { data, isPending, isError, error, refetch } = useWebsiteUsage(profileId, range);
  // Prefetched by this route's `page.tsx`, so the coverage note is in the first
  // paint rather than appearing under the table a beat later.
  const devices = useApiQuery(devicesQuery);

  const coverage = useMemo(
    () =>
      websiteCoverage(
        devicesForProfile(devices.data ?? [], profileId)
          // A machine revoked six months ago reports nothing and explains nothing. Left
          // in, one retired Windows laptop turned every day on a colleague's Mac into
          // "some of these devices cannot report addresses", which was false about the
          // only computer they use.
          .filter((device) => device.status !== "revoked")
          .map((device) => ({
            platform: device.platform,
            extension: device.browser_extension_linked,
            extensionSeenAt: device.browser_extension_seen_at,
            recording: device.website_addresses_recorded,
          })),
      ),
    [devices.data, profileId],
  );

  // `tableColumns` resolves each column's format against the document's decimal-hours
  // flag; the raw section columns have not had that applied.
  const columns = useMemo(() => tableColumns(data), [data]);
  const rows = useMemo(() => sectionOf(data)?.rows ?? [], [data]);
  const totals = sectionOf(data)?.totals ?? null;
  const totalSeconds = Number(cellOf(totals, "duration") ?? 0);
  const visits = Number(cellOf(totals, "visits") ?? 0);

  return (
    <div>
      <SectionHeading title="Websites" hint="Domains visited in the browser, busiest first." />

      <div className="space-y-3">
        {/* Shown whether or not there are rows: reading a short list and reading an
            empty one both depend on knowing what this person's fleet can see. */}
        {devices.isPending ? null : <CoveragePanel level={coverage.level} note={coverage.note} />}

        {data?.truncated ? <TruncationNotice /> : null}
        {(data?.notes ?? []).map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}

        {isError ? (
          <ErrorState
            title="Website usage could not be loaded"
            message={describeError(error)}
            onRetry={() => void refetch()}
          />
        ) : !day || isPending ? (
          <LoadingPanel />
        ) : rows.length === 0 ? (
          <Panel>
            <EmptyState title={emptyTitle(coverage.level)} body={emptyBody(coverage.level)} />
          </Panel>
        ) : (
          <>
            <Lead rows={rows} totalSeconds={totalSeconds} visits={visits} />
            <UsageTable columns={columns} rows={rows} totals={totals} caption="Website usage" />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "Recorded none" and "could record none" are different facts, and only the first is a
 * statement about what this person did.
 *
 * `mixed` gets neither. Part of the fleet can report addresses and part cannot, so on a
 * day with no rows there is genuinely no way to tell which happened, and picking either
 * sentence would assert something the data does not support — the body says so instead.
 */
function emptyTitle(level: CoverageLevel): string {
  if (level === "browser-url") return "No website activity recorded on this day";
  if (level === "mixed") return "No website activity on this day";
  return "No website activity could be recorded on this day";
}

/**
 * Why the list is empty, in the terms that actually apply to this person.
 *
 * The `unknown` case used to be told to "try another day", which is advice that cannot
 * work: nothing this person has can report a browser address, so every other day is
 * empty too. Sending someone off to page through a week for data that does not exist
 * is worse than saying so.
 */
function emptyBody(level: CoverageLevel): string {
  // Says the same thing as the coverage note above it, because they were contradicting
  // each other: the note correctly reported a mixed fleet while this asserted a single
  // computer with no extension.
  if (level === "mixed") {
    return "Some of this person's devices report browser addresses and some do not, so a day worked on the machine that cannot would look like this whether or not they browsed. Application usage for the same day is on the Apps tab, and the Devices tab says which machines report addresses.";
  }

  if (level === "window-title") {
    return "This person's Windows computer is not reporting browser addresses, and Windows gives the agent no other way to read one — so this day would look like this whether or not they browsed. Application usage for the same day is on the Apps tab, and the Devices tab says why.";
  }

  if (level === "unknown") {
    // Not "no device is enrolled": a Mac whose website collection has been switched off
    // lands here too, and it is very much enrolled.
    return "No enrolled device is reporting browser addresses for this person, and they come from the Windows and macOS agents only. Another day will look the same until that changes — the Devices tab is where to check.";
  }

  return "Browser time is captured only while a work session is open on an enrolled device. Use the day picker above to check another day.";
}

/**
 * What the browsing day amounted to, in a sentence, above the table that proves it.
 *
 * Named the busiest domain for the same reason the Apps tab does: the figures alone
 * are a measurement, and the thing a reader came for is the conclusion.
 */
function Lead({
  rows,
  totalSeconds,
  visits,
}: {
  rows: ReportRow[];
  totalSeconds: number;
  visits: number;
}) {
  const busiest = busiestRow(rows);
  const domain = String(cellOf(busiest, "domain") ?? "").trim();
  const busiestSeconds = Number(cellOf(busiest, "duration") ?? 0);
  const count = rows.length;

  return (
    <p className="text-sm">
      <span className="tabular font-medium">{duration(totalSeconds)}</span> across{" "}
      <span className="tabular">{count}</span> {count === 1 ? "domain" : "domains"}
      {visits > 0 ? (
        <>
          {" in "}
          <span className="tabular">{visits}</span> {visits === 1 ? "visit" : "visits"}
        </>
      ) : null}
      {domain && busiestSeconds > 0 ? (
        <>
          {" — mostly "}
          {/* Domains run long on a phone; the full value stays reachable on hover and
              in the table row below. */}
          <span className="font-medium break-all" title={domain}>
            {domain}
          </span>{" "}
          at <span className="tabular">{duration(busiestSeconds)}</span>.
        </>
      ) : (
        "."
      )}
    </p>
  );
}

/**
 * What this person's devices can actually see.
 *
 * Amber for the two platform-limited readings, because those explain missing rows.
 * Muted for the rest, which are statements of fact rather than caveats. The text
 * never blames the employee or the product — it names the platform.
 *
 * The amber comes through the `warning` token rather than an arbitrary
 * `border-[hsl(var(--warning))]/40`, so this panel is retuned for dark mode in
 * globals.css along with every other warning surface instead of on its own.
 */
function CoveragePanel({ level, note }: { level: CoverageLevel; note: string }) {
  const limited = level === "window-title" || level === "mixed";

  return (
    <div
      className={`flex gap-2.5 rounded-md px-3 py-2 text-xs ${
        limited ? "border border-warning/40 bg-warning/10" : "border bg-card text-muted-foreground"
      }`}
    >
      <Info
        className={`mt-px h-3.5 w-3.5 shrink-0 ${limited ? "text-warning" : "text-muted-foreground"}`}
        aria-hidden="true"
      />
      <span className="min-w-0">{note}</span>
    </div>
  );
}

function LoadingPanel() {
  return (
    <Panel>
      <span className="sr-only" aria-live="polite">
        Loading website usage
      </span>
      <SkeletonLines count={6} />
    </Panel>
  );
}
