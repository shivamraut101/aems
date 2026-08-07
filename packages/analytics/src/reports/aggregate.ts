import { clamp, difference, merge, toInterval, totalSeconds, type Interval } from "../intervals.js";
import { columnsFor, defaultGrouping, getReportType, isGroupingAllowed } from "./registry.js";
import type {
  CellValue,
  Grouping,
  ReportActivityRow,
  ReportBreakRow,
  ReportDataset,
  ReportDocument,
  ReportIdleRow,
  ReportProfileRow,
  ReportRequest,
  ReportRow,
  ReportSection,
} from "./types.js";

const DAY_MS = 86_400_000;
const UNKNOWN_EMPLOYEE = "Unknown employee";
const UNCATEGORIZED = "Uncategorized";

/**
 * Turns one period of raw events into a rendered-format-agnostic document.
 *
 * This is the only place report numbers are computed. The worker used to do its own
 * arithmetic and got four things wrong that the dashboard got right — no idle
 * subtraction, no window clamp, no overlap semantics on the fetch, and per-app spans
 * merged independently so two devices doubled the day. Sharing `intervals.ts` with
 * `summarisePeriod` is what stops that drift from being possible again.
 */
export function buildReportDocument(request: ReportRequest, data: ReportDataset): ReportDocument {
  const type = getReportType(request.kind);
  const grouping = isGroupingAllowed(request.kind, request.grouping)
    ? request.grouping
    : defaultGrouping(request.kind);

  const window: Interval = {
    start: Date.parse(request.periodStart),
    end: Date.parse(request.periodEnd),
  };

  const names = new Map(data.profiles.map((p) => [p.id, p] as const));
  const notes: string[] = [];

  if (data.truncated) {
    notes.push(
      "Row limit reached for this period — totals below are partial. Narrow the date range.",
    );
  }

  const section =
    request.kind === "time_and_activity"
      ? timeAndActivity(grouping, window, data, names)
      : request.kind === "app_usage"
        ? appUsage(grouping, window, data, names, notes)
        : request.kind === "website_usage"
          ? websiteUsage(grouping, window, data, names, notes)
          : workBreaks(grouping, window, data, names);

  section.columns = columnsFor(request.kind, grouping);

  return {
    kind: request.kind,
    title: request.title ?? type.label,
    subtitle: request.subtitle ?? "",
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    generatedAt: request.generatedAt ?? new Date().toISOString(),
    grouping,
    decimalDuration: request.decimalDuration ?? false,
    sections: [section],
    rowCount: section.rows.length,
    truncated: data.truncated ?? false,
    notes,
  };
}

/* ------------------------------------------------------------------------- */
/* Time & Activity                                                            */
/* ------------------------------------------------------------------------- */

interface TimeTotals {
  tracked: number;
  active: number;
  idle: number;
  break: number;
}

/**
 * The headline split for one *person* over one window.
 *
 * Merged within the person so two devices reporting the same hour count once, and
 * idle and break subtracted from active so the three columns partition the tracked
 * time rather than overlapping it. `tracked` is therefore |activity ∪ idle ∪ break|,
 * which is what makes `active + idle + break === tracked` hold exactly.
 */
function personTotals(
  activity: ReportActivityRow[],
  idle: ReportIdleRow[],
  breaks: ReportBreakRow[],
  window: Interval,
): TimeTotals {
  const activityIntervals = clampAll(
    activity.map((e) => toInterval(e.started_at, e.ended_at, window.end)),
    window,
  );
  const idleIntervals = clampAll(
    idle.map((e) => toInterval(e.idle_start_at, e.idle_end_at, window.end)),
    window,
  );
  const breakIntervals = clampAll(
    breaks.map((e) => toInterval(e.break_start_at, e.break_end_at, window.end)),
    window,
  );

  const breakSeconds = totalSeconds(breakIntervals);
  const idleSeconds = totalSeconds(difference(idleIntervals, breakIntervals));
  const activeSeconds = totalSeconds(
    difference(activityIntervals, [...idleIntervals, ...breakIntervals]),
  );

  return {
    tracked: activeSeconds + idleSeconds + breakSeconds,
    active: activeSeconds,
    idle: idleSeconds,
    break: breakSeconds,
  };
}

function addTotals(a: TimeTotals, b: TimeTotals): TimeTotals {
  return {
    tracked: a.tracked + b.tracked,
    active: a.active + b.active,
    idle: a.idle + b.idle,
    break: a.break + b.break,
  };
}

function timeCells(totals: TimeTotals): Record<string, CellValue> {
  return {
    tracked: totals.tracked,
    active: totals.active,
    idle: totals.idle,
    break: totals.break,
    activeRatio: totals.tracked === 0 ? 0 : Number((totals.active / totals.tracked).toFixed(4)),
  };
}

function timeAndActivity(
  grouping: Grouping,
  window: Interval,
  data: ReportDataset,
  names: Map<string, ReportProfileRow>,
): ReportSection {
  const perEmployee = grouping === "employee" || grouping === "employee_date";
  const perDate = grouping === "date" || grouping === "employee_date";

  const activityBy = groupBy(data.activity, (e) => e.profile_id);
  const idleBy = groupBy(data.idle, (e) => e.profile_id);
  const breakBy = groupBy(data.breaks, (e) => e.profile_id);
  const profileIds = new Set([...activityBy.keys(), ...idleBy.keys(), ...breakBy.keys()]);

  // Day windows are computed once. An interval spanning midnight belongs to both
  // days in the amount it actually covers, so clamping to each day is the split.
  const windows: { key: string; window: Interval }[] = perDate
    ? dayWindows(window)
    : [{ key: "", window }];

  const buckets = new Map<string, { profileId: string; date: string; totals: TimeTotals }>();

  for (const profileId of profileIds) {
    for (const day of windows) {
      const totals = personTotals(
        activityBy.get(profileId) ?? [],
        idleBy.get(profileId) ?? [],
        breakBy.get(profileId) ?? [],
        day.window,
      );
      if (totals.tracked === 0) continue;

      const key = `${perEmployee ? profileId : ""}|${day.key}`;
      const existing = buckets.get(key);
      buckets.set(key, {
        profileId,
        date: day.key,
        // Summed, never merged: across people these are genuinely different hours.
        totals: existing ? addTotals(existing.totals, totals) : totals,
      });
    }
  }

  const rows: ReportRow[] = [...buckets.values()].map((bucket) => ({
    cells: {
      ...(perEmployee ? employeeCells(bucket.profileId, names) : {}),
      ...(perDate ? { date: bucket.date } : {}),
      ...timeCells(bucket.totals),
    },
  }));

  rows.sort(byText(perDate ? "date" : "employee"));

  const grand = [...buckets.values()].reduce(
    (sum, bucket) => addTotals(sum, bucket.totals),
    { tracked: 0, active: 0, idle: 0, break: 0 },
  );

  return {
    heading: "Time & Activity",
    columns: [],
    rows,
    totals: { cells: { employee: "Total", date: null, department: null, ...timeCells(grand) } },
  };
}

/* ------------------------------------------------------------------------- */
/* Apps & URLs                                                                */
/* ------------------------------------------------------------------------- */

function appUsage(
  grouping: Grouping,
  window: Interval,
  data: ReportDataset,
  names: Map<string, ReportProfileRow>,
  notes: string[],
): ReportSection {
  const perEmployee = grouping === "employee";

  const buckets = rollUp(
    data.activity,
    window,
    (event) => (grouping === "category" ? (event.category ?? UNCATEGORIZED) : event.app_name),
    perEmployee,
  );

  const totalDuration = unionSecondsPerPerson(data.activity, window);
  let summed = 0;

  const categories = new Map<string, string>();
  for (const event of data.activity) {
    if (!categories.has(event.app_name)) categories.set(event.app_name, event.category ?? UNCATEGORIZED);
  }

  const rows: ReportRow[] = [];
  for (const bucket of buckets) {
    if (bucket.seconds === 0) continue;
    summed += bucket.seconds;

    rows.push({
      cells: {
        ...(perEmployee ? employeeCells(bucket.profileId, names) : {}),
        ...(grouping === "category" ? {} : { application: bucket.key }),
        category: grouping === "category" ? bucket.key : (categories.get(bucket.key) ?? UNCATEGORIZED),
        duration: bucket.seconds,
        opens: bucket.visits,
        share: totalDuration === 0 ? 0 : Number((bucket.seconds / totalDuration).toFixed(4)),
      },
    });
  }

  rows.sort(byDurationWithin(perEmployee));
  noteOverlap(notes, summed, totalDuration, "application");

  return {
    heading: "Application usage",
    columns: [],
    rows,
    totals: {
      cells: {
        employee: "Total",
        department: null,
        application: null,
        category: null,
        duration: totalDuration,
        // Summed, not merged: two devices reporting the same app are two openings of
        // it, even where the overlapping *time* is only counted once above.
        opens: rows.reduce((sum, row) => sum + Number(row.cells["opens"] ?? 0), 0),
        share: null,
      },
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Website usage                                                              */
/* ------------------------------------------------------------------------- */

function websiteUsage(
  grouping: Grouping,
  window: Interval,
  data: ReportDataset,
  names: Map<string, ReportProfileRow>,
  notes: string[],
): ReportSection {
  const perEmployee = grouping === "employee";
  const withDomain = data.activity.filter((e) => e.domain !== null && e.domain !== "");

  const buckets = rollUp(withDomain, window, (event) => event.domain ?? "", perEmployee);

  const totalDuration = unionSecondsPerPerson(withDomain, window);
  let summed = 0;
  let visits = 0;

  const rows: ReportRow[] = [];
  for (const bucket of buckets) {
    if (bucket.seconds === 0) continue;
    summed += bucket.seconds;
    visits += bucket.visits;

    rows.push({
      cells: {
        ...(perEmployee ? employeeCells(bucket.profileId, names) : {}),
        domain: bucket.key,
        duration: bucket.seconds,
        visits: bucket.visits,
        share: totalDuration === 0 ? 0 : Number((bucket.seconds / totalDuration).toFixed(4)),
      },
    });
  }

  rows.sort(byDurationWithin(perEmployee));
  noteOverlap(notes, summed, totalDuration, "domain");

  return {
    heading: "Website usage",
    columns: [],
    rows,
    totals: {
      cells: {
        employee: "Total",
        department: null,
        domain: null,
        duration: totalDuration,
        visits,
        share: null,
      },
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Work breaks                                                                */
/* ------------------------------------------------------------------------- */

function workBreaks(
  grouping: Grouping,
  window: Interval,
  data: ReportDataset,
  names: Map<string, ReportProfileRow>,
): ReportSection {
  const perEmployee = grouping === "employee" || grouping === "employee_date";
  const perDate = grouping === "date" || grouping === "employee_date";

  if (grouping === "event") {
    const rows: ReportRow[] = [];
    let total = 0;

    for (const record of data.breaks) {
      const start = Date.parse(record.break_start_at);
      if (!Number.isFinite(start) || start >= window.end || start < window.start) continue;

      // An unfinished break has no end. Substituting the window end would invent a
      // duration the employee never declared, so both cells stay empty instead.
      const end = record.break_end_at === null ? null : Date.parse(record.break_end_at);
      const seconds = end === null ? null : Math.max(0, Math.round((end - start) / 1000));
      if (seconds !== null) total += seconds;

      rows.push({
        cells: {
          ...employeeCells(record.profile_id, names),
          date: record.break_start_at,
          breakStart: record.break_start_at,
          breakEnd: record.break_end_at,
          duration: seconds,
        },
      });
    }

    rows.sort(byText("breakStart"));

    return {
      heading: "Work breaks",
      columns: [],
      rows,
      totals: {
        cells: {
          employee: "Total",
          department: null,
          date: null,
          breakStart: null,
          breakEnd: null,
          duration: total,
        },
      },
    };
  }

  const buckets = new Map<
    string,
    { profileId: string; date: string; count: number; total: number; longest: number }
  >();
  let grandCount = 0;
  let grandTotal = 0;
  let grandLongest = 0;

  for (const record of data.breaks) {
    const start = Date.parse(record.break_start_at);
    if (!Number.isFinite(start) || start >= window.end || start < window.start) continue;

    const end = record.break_end_at === null ? null : Date.parse(record.break_end_at);
    const seconds = end === null ? 0 : Math.max(0, Math.round((end - start) / 1000));
    const date = new Date(start).toISOString().slice(0, 10);
    const key = `${perEmployee ? record.profile_id : ""}|${perDate ? date : ""}`;

    const existing = buckets.get(key) ?? {
      profileId: record.profile_id,
      date,
      count: 0,
      total: 0,
      longest: 0,
    };
    existing.count += 1;
    existing.total += seconds;
    existing.longest = Math.max(existing.longest, seconds);
    buckets.set(key, existing);

    grandCount += 1;
    grandTotal += seconds;
    grandLongest = Math.max(grandLongest, seconds);
  }

  const rows: ReportRow[] = [...buckets.values()].map((bucket) => ({
    cells: {
      ...(perEmployee ? employeeCells(bucket.profileId, names) : {}),
      ...(perDate ? { date: bucket.date } : {}),
      breaks: bucket.count,
      duration: bucket.total,
      longest: bucket.longest,
    },
  }));

  rows.sort(byText(perEmployee ? "employee" : "date"));

  return {
    heading: "Work breaks",
    columns: [],
    rows,
    totals: {
      cells: {
        employee: "Total",
        department: null,
        date: null,
        breaks: grandCount,
        duration: grandTotal,
        longest: grandLongest,
      },
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------- */

function employeeCells(
  profileId: string,
  names: Map<string, ReportProfileRow>,
): Record<string, CellValue> {
  const profile = names.get(profileId);
  return {
    employee: profile?.full_name || (profile ? profile.email : UNKNOWN_EMPLOYEE),
    department: profile?.department ?? null,
  };
}

interface RolledBucket {
  profileId: string;
  key: string;
  seconds: number;
  visits: number;
}

/**
 * Groups activity by a key, merging within one person and summing across people.
 *
 * The merge boundary is the whole point. Merging one person's spans stops a laptop
 * and a phone reporting the same hour from being counted twice; merging across
 * people would erase the fact that two employees really did both work that hour.
 * A single `totalSeconds` over every matching span gets the first right and the
 * second wrong — which is what "VS Code, 10800s" versus "7200s" comes down to.
 */
function rollUp(
  events: ReportActivityRow[],
  window: Interval,
  keyOf: (event: ReportActivityRow) => string,
  perEmployee: boolean,
): RolledBucket[] {
  const perPerson = new Map<string, { intervals: Interval[]; visits: number }>();

  for (const event of events) {
    const trimmed = clamp(toInterval(event.started_at, event.ended_at, window.end), window);
    if (!trimmed) continue;

    const compound = `${event.profile_id} ${keyOf(event)}`;
    const existing = perPerson.get(compound);
    if (existing) {
      existing.intervals.push(trimmed);
      existing.visits += 1;
    } else {
      perPerson.set(compound, { intervals: [trimmed], visits: 1 });
    }
  }

  const rolled = new Map<string, RolledBucket>();

  for (const [compound, bucket] of perPerson) {
    const separator = compound.indexOf(" ");
    const profileId = compound.slice(0, separator);
    const key = compound.slice(separator + 1);
    const displayKey = perEmployee ? compound : key;

    const seconds = totalSeconds(bucket.intervals);
    const existing = rolled.get(displayKey);

    if (existing) {
      existing.seconds += seconds;
      existing.visits += bucket.visits;
    } else {
      rolled.set(displayKey, { profileId, key, seconds, visits: bucket.visits });
    }
  }

  return [...rolled.values()];
}

/**
 * Merged wall-clock seconds, per person, then summed.
 *
 * Two apps focused at once on two of one person's devices are one hour of that
 * person's day; two people working the same hour are two hours of the company's.
 * Merging across people would erase the second fact.
 */
function unionSecondsPerPerson(activity: ReportActivityRow[], window: Interval): number {
  const byProfile = groupBy(activity, (e) => e.profile_id);
  let total = 0;

  for (const events of byProfile.values()) {
    total += totalSeconds(
      clampAll(
        events.map((e) => toInterval(e.started_at, e.ended_at, window.end)),
        window,
      ),
    );
  }

  return total;
}

/**
 * Flags the gap between the sum of the rows and the merged total.
 *
 * The old CSV merged each application's spans independently, so a laptop and a phone
 * both reporting 09:00–10:00 produced rows summing to two hours of a one-hour window
 * — with no total row to expose it. Now the totals row is the merged number and the
 * discrepancy is stated rather than hidden.
 */
function noteOverlap(notes: string[], summed: number, union: number, unit: string): void {
  if (summed <= union + 1) return;
  notes.push(
    `Rows sum to ${Math.round(summed / 60)} minutes against ${Math.round(union / 60)} minutes of ` +
      `merged time: some ${unit} time overlapped across devices. The total row is merged time.`,
  );
}

function clampAll(intervals: Interval[], window: Interval): Interval[] {
  const trimmed: Interval[] = [];
  for (const interval of intervals) {
    const result = clamp(interval, window);
    if (result) trimmed.push(result);
  }
  return merge(trimmed);
}

/** UTC day slices covering the window. Timezone is a separate, deliberate decision. */
function dayWindows(window: Interval): { key: string; window: Interval }[] {
  const slices: { key: string; window: Interval }[] = [];
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end)) return slices;

  let dayStart = Math.floor(window.start / DAY_MS) * DAY_MS;

  // Bounded so a malformed range cannot spin here.
  for (let guard = 0; dayStart < window.end && guard < 400; guard += 1) {
    const slice = clamp({ start: dayStart, end: dayStart + DAY_MS }, window);
    if (slice) {
      slices.push({ key: new Date(dayStart).toISOString().slice(0, 10), window: slice });
    }
    dayStart += DAY_MS;
  }

  return slices;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const existing = map.get(k);
    if (existing) existing.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function byText(field: string): (a: ReportRow, b: ReportRow) => number {
  return (a, b) => String(a.cells[field] ?? "").localeCompare(String(b.cells[field] ?? ""));
}

/** Busiest first — grouped under the employee when the rows carry one. */
function byDurationWithin(perEmployee: boolean): (a: ReportRow, b: ReportRow) => number {
  return (a, b) => {
    if (perEmployee) {
      const byName = String(a.cells["employee"] ?? "").localeCompare(
        String(b.cells["employee"] ?? ""),
      );
      if (byName !== 0) return byName;
    }
    return Number(b.cells["duration"] ?? 0) - Number(a.cells["duration"] ?? 0);
  };
}
