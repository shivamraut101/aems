import type { LiveWorkforceRow, OverviewMetrics } from "@/lib/api";

/**
 * The sentence the Overview leads with, and who it is about.
 *
 * The page used to open with five equal figures — employees, active now, working
 * today, hours, focused — and left the reader to work out from them whether anything
 * needed doing. That is arithmetic the screen can do itself, and the research on
 * dashboard hierarchy is blunt about the cost of not doing it: lead with the one
 * reading that answers "is everything okay?", then let the figures support it.
 *
 * So this decides two things and nothing else: how many people are working, and which
 * one person is most worth looking at. Pure, because a wrong verdict is worse than no
 * verdict — it points a manager at the wrong employee — and that deserves tests rather
 * than a screenshot.
 */

/** How long a person can go unseen before the page mentions them. */
export const STALE_AFTER_HOURS = 20;

export interface Attention {
  profileId: string;
  name: string;
  /** Written for a reader, not a log: the clause that follows their name. */
  reason: string;
}

export interface Verdict {
  working: number;
  total: number;
  /** The single person most worth a look, or null when nothing stands out. */
  attention: Attention | null;
}

function displayName(row: Pick<LiveWorkforceRow, "fullName" | "email">): string {
  return row.fullName?.trim() || row.email || "Someone";
}

/**
 * Ranked, not filtered.
 *
 * Naming every person with something slightly off produces a paragraph nobody reads,
 * so exactly one is surfaced and the order below is the claim about which matters:
 *
 *  1. Enrolled but silent — a machine that *should* be reporting and is not. This is
 *     the only case that can mean something is broken rather than merely absent.
 *  2. No device at all — worth saying once, but it is a setup task, not an incident.
 *
 * Someone simply offline at the end of their day is neither, and is never surfaced;
 * a dashboard that cries about every finished shift trains people to ignore it.
 */
export function computeVerdict(
  metrics: OverviewMetrics | undefined,
  live: readonly LiveWorkforceRow[] | undefined,
  now: number,
): Verdict | null {
  if (!metrics) return null;

  const rows = live ?? [];
  const staleBefore = now - STALE_AFTER_HOURS * 3_600_000;

  const silent = rows.find(
    (row) =>
      row.deviceId !== null &&
      row.status === "offline" &&
      row.lastSeenAt !== null &&
      Date.parse(row.lastSeenAt) < staleBefore,
  );

  if (silent) {
    return {
      working: metrics.workingToday,
      total: metrics.totalEmployees,
      attention: {
        profileId: silent.profileId,
        name: displayName(silent),
        reason: "has a device enrolled but it has not reported today",
      },
    };
  }

  const unenrolled = rows.filter((row) => row.deviceId === null);
  if (unenrolled.length > 0) {
    const first = unenrolled[0]!;
    return {
      working: metrics.workingToday,
      total: metrics.totalEmployees,
      attention: {
        profileId: first.profileId,
        name: displayName(first),
        reason:
          unenrolled.length === 1
            ? "has no device enrolled yet"
            : `and ${unenrolled.length - 1} other${unenrolled.length > 2 ? "s" : ""} have no device enrolled yet`,
      },
    };
  }

  return { working: metrics.workingToday, total: metrics.totalEmployees, attention: null };
}

/**
 * The reassuring half.
 *
 * Only said when it is true of everyone. "Everyone else is on track" beside a warning
 * is a different claim from "everyone is on track", and conflating them is how a
 * dashboard earns its reputation for lying.
 */
export function verdictAllClear(verdict: Verdict): boolean {
  return verdict.attention === null && verdict.working > 0;
}
