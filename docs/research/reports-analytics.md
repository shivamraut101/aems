# Reports and analytics

> Report types, columns, formats, exports, team comparison, trends, AI summaries,
> and scheduling.
> Serves `docs/scope.md` §5 (High) and §6 (Medium).

Read source: Kimai (`src/Reporting`, `src/Export`, `src/Repository/Query`) at `main`;
Cattr `server-application` (`app/Models/UniversalReport.php`, `app/Enums`, `routes/api.php`)
at `main`. Vendor documentation: Hubstaff, Apploye, ActivTrak.

Kimai is AGPL-3.0 and Cattr is SSPL. Nothing below is copied; every structure is
described in prose.

---

## 1. A report is a registered object with an identity

**VERIFIED — Kimai `src/Reporting/ReportInterface.php`, `Report.php`, `ReportingService.php`.**

Their report interface is three methods — id, label, route — and the concrete report is
a final immutable value object. The service dispatches an event, adds reports
**conditionally behind permission checks** (a base `view_reporting` gate, then category
gates for user / project / customer reports), and returns the collected list. So *the
list of reports a user may run is itself derived from role*, not hardcoded in the UI.

Their directory names are the actual catalogue: `WeekByUser`, `MonthByUser`,
`YearByUser`, `WeeklyUserList`, `MonthlyUserList`, `YearlyUserList`, `ProjectView`,
`ProjectDetails`, `ProjectDateRange`, `ProjectInactive`, `CustomerMonthlyProjects`,
`DateByUser`.

Note the pairing: `WeekByUser` (one user × days) and `WeeklyUserList` (all users × days)
are **the same period, transposed**. That transpose is exactly the "employee report vs
team report" split scope §5 asks for.

**VERIFIED — Kimai `src/Reporting/AbstractUserList.php`.** A report's configuration is a
small, named, validated object — five fields: date, `decimal` (bool), `sumType`
(validated against an enum, throwing on anything else), team, project. Not a free-form
filter bag.

`decimal` is the standout and is worth stealing outright: it selects a different **cell
formatter** for the same column — natural `1:15` versus decimal `1.25`. Accounting
systems need one; humans need the other. One flag, two renderings, same data.

### Verdict

**ADAPT.** We do not need Symfony events or a DI container; we need a typed registry so
`kind` stops being an opaque enum that changes nothing. **ADOPT the `decimal` flag** —
our `seconds` column is neither natural nor decimal, and a manager pasting `27000` into
Excel gets nothing useful.

---

## 2. Renderers are a registry; the query names the renderer

**VERIFIED — Kimai `src/Export/ServiceExport.php`, the four renderer factories, and
`src/Repository/Query/ExportQuery.php`.** Renderers are collected into a service and
resolved by id at render time. The export query carries a `renderer` string — **format
is a property of the request**, and the aggregation code has no idea which format it
feeds.

Columns are built by a converter that pairs a name with a formatter plus a closure
extractor, with null-safe chains for nested relations. Column ids are namespaced strings
— `date`, `begin`, `end`, `duration`, `billable`, `user.alias`, `customer.name`,
`project.number`. Rate columns are conditionally included on permission.

**VERIFIED / DOCUMENTED — Kimai export docs plus the coexistence of PDF and HTML
renderer factories.** Four formats: PDF, XLSX, CSV, HTML. HTML is described as "a
browser-friendly print view that you can review or save as PDF" — i.e. **PDF and HTML
share one template**, differing only by extension. Per-format options are explicit: PDF
takes title, include-summary, font, page size (A4/A5/A6/Legal/Letter) and orientation;
CSV takes a separator (comma or semicolon).

### Verdict

**ADOPT the seam.** One aggregation pass, N renderers, is precisely what we lack. See §7 B.

---

## 3. Saved report definitions — two products converged independently

**VERIFIED — Cattr `app/Models/UniversalReport.php` and `app/Enums/UniversalReportType.php`.**
A stored report definition holds a name, a type (`company` or `personal`), a **base**
(the axis it pivots on — project / user / task), a set of data-object ids, a set of
fields, and a set of charts, all owned by a user. Kimai's "export template" is the same
idea: a stored, reusable, optionally-shareable config holding file type, header
language and column selection.

Cattr's route shape is worth naming because it is the right split:

```
GET  report/universal-report/bases                    -> what can I pivot on
GET  report/universal-report/data-objects-and-fields  -> what columns exist for that pivot
POST report/universal-report/generate                 -> render to screen (JSON)
POST report/universal-report/download                 -> same filters, returns the file
```

Every report in their API follows that `POST report/X` + `POST report/X/download`
pattern, same body.

### Verdict

**ADAPT the render/download split now — REJECT the saved-template model for the MVP.**
The split matters: a manager who must wait for a background job to see a number will not
use the feature. Saved templates and a report builder are genuinely the best idea in
either reference codebase and genuinely out of scope — §5 asks for report *types*, not a
builder. **PHASE 2.**

---

## 4. What the catalogue looks like when it is credible

**DOCUMENTED — Hubstaff, support.hubstaff.com.** Twenty-three reports. The ones inside
our scope:

| Report | Content | Filters / grouping |
| --- | --- | --- |
| Time & Activity | Total time + activity % by user/project | clients, projects, members |
| Daily Totals | Daily and weekly totals per workweek | — |
| Work Sessions | Timer start/stop rows | grouped by `date`, `member`, `member & date`, `project`, `client` |
| Apps & URLs | Time per application and website | item type, projects, members |
| Work Breaks | Break time by member, with status and duration | grouped by `member`, `date`, `policy` |

Two structural facts matter more than the list: **grouping is a named, enumerated choice
per report**, not a free pivot; and **CSV and PDF are offered on nearly every report** —
a PDF-less report reads as unfinished.

**DOCUMENTED — Apploye.** Time & Activity, Manual Time, Apps & URL Usage, exported as
PDF / CSV / Excel.

**DOCUMENTED — ActivTrak.** Their metric grid is 2×3, not 1×2: Screen Time = Productive
+ Unproductive + Undefined, each splitting again into Active (input detected) and Passive
(no input but still work — a call, a training video), explicitly "not considered idle
time", default active-to-passive threshold two minutes. Team Comparison frames every
metric against a per-team **goal** — actual productive hours over expected productive
hours.

### Verdicts

**ADOPT the grouping-as-enum idea and four report types** — Time & Activity, Apps &
URLs, Website Usage, Work Breaks. Our `break_events` table already exists and is read by
nothing, so a Work Breaks report is nearly free and discharges a §2.2 clause at the same
time.

**ADAPT ActivTrak's Productive / Unproductive / Undefined axis** — available today from
`activity_events.category` plus the rule engine in `activity-engine.md` §5. **REJECT
their Active/Passive axis for the MVP** (needs a second agent-side threshold; different
workstream). **REJECT goals** — the best framing they have, fits `docs/design.md`'s
instruction better than anything else found, and has no basis in `docs/scope.md`.
**PHASE 2**, stated plainly.

---

## 5. Export watermarking — considered and rejected

**VERIFIED — Kimai `ExportQuery` carries a `markAsExported` flag; the repository
interface declares a `setExported()` method, and the query defaults to
not-yet-exported rows only.** A second export never re-includes rows already exported.

**REJECT.** This exists to stop double-invoicing. We are not billing. Importing it would
add a mutable flag to `activity_events` — our highest-volume append-only table — for no
benefit.

---

## 6. What we do today

**The queue and download API are the good part.** `apps/api/src/routes/reports.ts` —
`POST /` inserts a `pending` row and returns, with generation deliberately async;
`GET /:id/download` re-checks `company_id`, blocks an employee reading someone else's
report, 409s unless the status is `ready`, and mints a 5-minute signed URL. The failure
path flips the row to `failed` rather than leaving it pending. All correct instincts.

**Everything downstream of it is one CSV.** `supabase/functions/report-worker/index.ts`:

- The header is literally `profile_id,app_name,seconds`.
- `report.kind` is read **only to name the file**. A `daily`, a `weekly` and a `team`
  report produce byte-identical column sets. Scope §5 names three distinct report
  families.
- The interval merge is a hand-copy of `packages/analytics/src/intervals.ts:27-50`.
  **`difference()` — the idle subtraction — was not copied**, so the CSV counts idle
  seconds as app time while the dashboard does not.
- The window filter is `.gte("started_at", period_start)`, while
  `routes/analytics.ts:41-42` uses overlap semantics. An event running 08:45–09:30
  against a 09:00–17:00 window is **omitted entirely** by the CSV and counted as 1800s
  by `/productivity`.
- The end fallback is `event.ended_at ? parse(ended_at) : periodEnd` — `periodEnd` is
  only the *null* fallback, **never a cap**. An event running 16:50–18:20 against a
  window ending at 17:00 is credited 5400s by the CSV and 600s by `summarisePeriod`,
  which clamps.
- Each app's spans are merged **independently**, so two apps focused simultaneously on
  two devices each get their full duration. A laptop and a phone both reporting
  09:00–10:00 produce rows summing to 7200s for a 3600-second hour. There is no total
  row to expose the discrepancy.
- CSV mechanics are not Excel-safe: no UTF-8 BOM, LF line endings, `app_name` quoted but
  `profile_id` not, and **no guard against a leading `=`, `+`, `-` or `@`**. Window
  titles are attacker-influenced text and this file is opened in Excel by an admin.

**The 1000-row cap applies here too**, and it is the single most damaging defect in this
area. `supabase/config.toml:10` sets `max_rows = 1000`; the report worker's query has no
`.range()` and no pagination loop, and neither do the analytics routes. A real 8-hour day
produces well over 1000 focus intervals, so **every report longer than about half a day
is already wrong**, silently.

**No time series exists.** `analytics.ts` exposes `/productivity`, `/timeline`,
`/websites`, `/overview` and `/live`. Nothing returns an array keyed by day.
`docs/design.md` puts "Productivity Trend" on the dashboard home and scope §5 asks for
"productivity trends"; Recharts has nothing to render.

**Team reports have no team.** `reports.ts:37` gates on `requireManager` but never
consults `profiles.manager_id` (added in `...0004.sql:14`). The worker filters on
`company_id` and optionally one `profile_id`. A manager with two direct reports in a
40-person company gets all forty.

**`break_events` is collected and read by nothing.** The table exists with a generated
`duration_seconds`, the DTO exists, ingestion accepts it at
`apps/api/src/routes/activity.ts:202` — and a grep of `packages/analytics/src` and
`supabase/functions` finds zero readers.

**The AI summary's numbers agree with nothing.**
`supabase/functions/ai-summary-worker/index.ts` computes
`activeSeconds = topApps.reduce(...)` where `topApps` is the top **8** apps, over totals
built by plain addition with **no interval merge and no idle subtraction**. A person
using twelve apps gets a number strictly smaller than `/api/analytics/productivity`
returns; a person on two devices gets one strictly larger. The AI text is the most
quotable surface in the product and it is the least consistent one.

Two more: the worker `.insert()`s and `ai_summaries` has **no unique index** on
`(company_id, profile_id, kind, period_start)`, so re-running it duplicates rows with no
rule for which the UI shows. And `kind` is hardcoded `"daily"` — scope §6 asks for daily,
weekly and insights, and the schema's check constraint already permits all three
(`...0001.sql:280`). The schema was designed for this and the worker never caught up.

**Nothing schedules anything.** `pg_cron` 1.6.4 and `pg_net` 0.20.4 are available on the
project with `installed_version: null`. A grep for `cron` finds nothing outside
`node_modules`. Scope §6 asks for a "daily" and a "weekly" summary — those are schedule
words. The notification worker already builds `report_ready` alerts that nothing
triggers.

**`/reports` and `/insights` are dead links.**
`apps/admin-dashboard/src/components/app-shell.tsx:25-26` renders both; neither page
exists. `apps/admin-dashboard/src/app/page.tsx:41-44` passes hardcoded placeholder prose
into `ai-insight.tsx`, whose props — `breakdown`, `observation`, `recommendation` — are
the exact three-part structure `docs/design.md:189-202` specifies, and which nothing in
the codebase produces because the worker writes one flat prose blob.

**The report row cannot explain itself.** The `reports` table stores kind, period,
status and storage path. Not stored: who requested it, what filters produced it, how many
rows it contains, why it failed. `reports.ts:99` surfaces "Report is failed" with no
cause; the reason lives only in an Edge Function log.

Two things we do better than either reference, worth protecting: our interval algebra
(`packages/analytics/src/intervals.ts`) is more correct than Kimai's or Cattr's — Kimai
aggregates non-overlapping timesheet entries and never had to solve multi-device
overlap, and Cattr does not solve it — and `summarisePeriod` is properly tested
(`productivity.test.ts:108-149` proves idle subtraction, window clamping, and
two-device de-duplication). **The gap is not our maths. It is that the report worker
does not use it.**

---

## 7. Recommendations

All Fastify + Supabase Edge Functions + Next.js 15 + Recharts. No new runtime, no ORM,
no queue.

### A — Move aggregation into Postgres and delete the row cap. **ADOPT (forced by our own defect).**

Pagination alone does not fix this: a 30-day team report would page hundreds of
thousands of rows into a 150 MB Edge Function. Push the interval algebra into SQL where
the data is.

Postgres 17.6 (confirmed on our project) has multirange types, which are
`intervals.ts` in the database:

```sql
-- sketch, NOT verified by execution - spike this first
active_span := range_agg( tstzrange(started_at, coalesce(ended_at, window_end)) )  -- merge()
idle_span   := range_agg( tstzrange(idle_start_at, coalesce(idle_end_at, window_end)) )
net         := active_span - idle_span                                             -- difference()
active_secs := sum(extract(epoch from (upper(r) - lower(r)))) from unnest(net) r
```

Expose as SQL functions called through `supabase.rpc(...)` — a migration, not an ORM, so
`docs/stack.md` §5 holds. Three cover everything below:
`report_employee_totals(company, profiles[], from, to)`, `report_app_totals(...)`,
`report_daily_series(...)`.

Keep `packages/analytics/src/intervals.ts` as the **oracle**: port the existing cases
from `productivity.test.ts:50-149` into `supabase/tests/` as pgTAP assertions so the SQL
and the TypeScript are proven to agree. That test file is why this change is safe to
make.

> **INFERRED, not executed.** I read the PG17 multirange feature set; I did not run
> `range_agg(tstzrange) - range_agg(tstzrange)` against our schema. Spike the empty-range
> and open-ended-range behaviour before committing to it.

Files: `supabase/migrations/20260805000007_report_aggregates.sql` (new),
`apps/api/src/routes/analytics.ts`, `supabase/functions/report-worker/index.ts`,
`supabase/functions/ai-summary-worker/index.ts`.

### B — Split render from serialise; add PDF. **ADOPT Kimai's seam.**

1. Aggregation produces one runtime value, a `ReportDocument`:
   `{ title, periodStart, periodEnd, generatedAt, sections: [{ heading, columns, rows, totals? }] }`.
2. `renderers/csv.ts` and `renderers/pdf.ts` each consume it. The renderer is chosen by
   `report.format` through a `Record<ReportFormat, Renderer>` map — Kimai's resolve-by-id
   idea without the DI container.
3. `ColumnDef` carries `{ id, label, format }` where format is one of
   `text | seconds | duration | decimalHours | date | percent`. `duration` renders
   `7h 30m`; `decimalHours` renders `7.50`. **That is Kimai's `decimal` flag, adopted**,
   exposed as `POST /api/reports { decimalDuration: boolean }`.

**PDF library: `pdf-lib`.** Its README states it is tested in Node, Browser, Deno and
React Native, and the 14 standard PDF fonts are embedded in the package with no
filesystem read. That matters: the known Supabase failure mode is `pdfkit`, which trips
a blocklisted `Deno.readFileSync` reading font files. Import as `npm:pdf-lib`.

**Handle this edge case up front:** the standard fonts are WinAnsi-encoded, so an
employee whose name carries a macron or a Devanagari character throws on `drawText`.
Either sanitise to Latin-1 with a visible fallback, or bundle one TTF as a base64 asset
and embed it. Decide before the client sees a non-ASCII name, not after.

Fix the CSV mechanics inside the same work: UTF-8 BOM, CRLF line endings, quote **every**
field, and prefix any cell beginning `=`, `+`, `-`, `@`, tab or CR with a single quote.

Files: `supabase/functions/report-worker/{index.ts, document.ts, renderers/csv.ts,
renderers/pdf.ts}`, migration adds `format`, `apps/api/src/routes/reports.ts:5-10`,
`packages/types/src/dto.ts`.

**REJECT XLSX** — Hubstaff and Apploye offer it; scope §5 names CSV and PDF. The seam
makes it a one-file addition whenever it is asked for.

### C — Four real report types. **ADAPT Kimai's registry, ADOPT Hubstaff's grouping enum.**

Replace `kind: daily|weekly|team` — which currently changes nothing — with a plain TS
discriminated union registry, no events and no DI:

```ts
interface ReportType {
  id: ReportKind;
  label: string;
  groupings: readonly Grouping[];   // enumerated, not a free pivot
  columns: readonly ColumnDef[];
  minRole: "manager" | "employee";
}
```

| id | Columns | Groupings | Scope |
| --- | --- | --- | --- |
| `time_and_activity` | Employee, Department, Date, Tracked, Active, Idle, Break, Active % | employee, date, employee+date | §5 "total working hours, active hours, idle time" |
| `app_usage` | Employee, Application, Category, Duration, % of active | employee, application, category | §5 "application usage" |
| `website_usage` | Employee, Domain, Duration, Visits | employee, domain | §5 "website usage" |
| `work_breaks` | Employee, Date, Break start, Break end, Duration | employee, date | §5 + §2.2 "break time" |

Each gets a **totals row** computed via the merged-union path from (A), so the per-app
double-count becomes visible rather than silent.

`profileId: string | null` becomes `profileIds: string[] | "my_team" | "all_company"`,
with `"my_team"` resolving through `profiles.manager_id`. That is the team report
actually being a team report.

**Screenshot history is deliberately excluded from CSV and PDF.** A report of storage
paths is useless and a report of embedded images is enormous. The screenshot timeline UI
covers scope §5's clause. Say this to the client rather than shipping a column of opaque
keys.

### D — Trend and team endpoints. **ADAPT ActivTrak's master-detail.**

- `GET /api/analytics/trend?profileId&from&to&granularity=day|week` returns
  `{ date, trackedSeconds, activeSeconds, idleSeconds, breakSeconds }[]`, backed by the
  `report_daily_series` RPC so it does not re-fetch raw events. This is what
  `docs/design.md`'s "Productivity Trend" chart binds to — Recharts `<AreaChart>`, no new
  library.
- `GET /api/analytics/team?from&to&scope=my_team|company` returns one row per employee
  with totals, top app, and a `trend: number[]` sparkline. That single response drives
  all three of §5's team asks: comparison (the table), trends (the sparkline column), and
  working patterns (a peak-hour histogram from the same series).

Render the team table with TanStack Table and, on row select, swap the panel below into
that person's timeline for the same range — no navigation. It reuses
`components/activity-timeline.tsx` unchanged. See `dashboard-ia.md` §3.

### E — Schedule the workers. **ADOPT.**

`pg_cron` and `pg_net` are available and uninstalled. Install both, then three jobs
posting to the existing function URLs with the `x-worker-secret` header that
`supabase/functions/_shared/client.ts:23-33` already checks:

| Worker | Schedule |
| --- | --- |
| `report-worker` | every 2 minutes — drain the pending queue |
| `ai-summary-worker` | daily 02:00 UTC |
| `notification-worker` | every 15 minutes |

Not a stack change: Edge Functions remain the worker runtime per `docs/stack.md` §9;
`pg_cron` only pulls the trigger. **`pgmq` is available on the project and must not be
used** — CLAUDE.md forbids a separate queue, and `reports.status = 'pending'` already is
the queue.

**REJECT scheduled email delivery.** Hubstaff's version is well specified — recipients
(comma-separated, may be external), message body, file type, custom name, a relative
date-range vocabulary, frequency, delivery time. Scope §5 says "Export: CSV, PDF" and
stops there. **PHASE 2.** The one piece worth taking now is the *relative date-range
vocabulary* — `this_week`, `last_week`, `this_month`, `last_month` — because
`apps/admin-dashboard/src/store/filters.ts:12` already has a weaker version of it.

### F — Make the AI surface honest and structured.

1. **Fix the numbers.** Replace the top-8-apps sum with the same
   `report_employee_totals` RPC the dashboard and the CSV use. One source of truth, or
   the differentiating feature is the least trustworthy screen in the product.
2. **Idempotency.** Create a unique index on
   `ai_summaries (company_id, profile_id, kind, period_start)` and change the insert to
   an upsert with `onConflict` — the same pattern ingestion already uses via
   `client_event_id`.
3. **Structure the output.** Add `structured jsonb` holding
   `{ breakdown: [{label, percentage}], observation, recommendation }` — the exact props
   `ai-insight.tsx:5-16` already declares. Ask the model for JSON alongside the prose and
   keep `content` as the prose fallback, so a malformed response degrades instead of
   breaking the panel.
4. **Weekly and team.** Add `kind: 'weekly'` (Mondays, week-to-date) and
   `kind: 'insight'` (manager-level, per team, fed by D). The check constraint already
   permits both.
5. `GET /api/analytics/summaries?profileId&kind&from&to` so the dashboard can read them.

Keep the existing compliance property: **aggregates only in the prompt, never window
titles or URLs.** It is right, it is documented in the worker's own comment, and it
survives all of the above.

### G — The two missing pages.

`/reports`: left rail is the catalogue from (C); right is the filter form (React Hook
Form + Zod, schema shared with the API's `createSchema`); below is the run history table
over `GET /api/reports` with per-row status and a download button hitting the existing
`/:id/download`. **Two buttons, per Cattr's split: "Run" renders to screen, "Export"
queues the file with the same filters.**

`/insights`: the (F) summaries in `<AiInsight>`, indigo only per `docs/design.md`.

Extend `store/filters.ts:12` with the relative vocabulary from (E). It is a Zustand enum
and four more cases in the existing `resolveRange` switch.

---

## Summary of verdicts

| # | Finding | Verdict | Touches |
| --- | --- | --- | --- |
| A | Postgres-side aggregation via multiranges; kill the 1000-row cap | **ADOPT** (own defect) | migration `...0007`, `routes/analytics.ts`, both workers |
| B | Renderer seam + PDF via `pdf-lib` + CSV hardening | **ADOPT** Kimai's seam | `report-worker/*`, `routes/reports.ts`, `dto.ts` |
| C | Four report types with real columns and enumerated groupings | **ADAPT** Kimai, **ADOPT** Hubstaff grouping | `analytics/reports/*`, `report-worker`, `routes/reports.ts` |
| D | `/trend` + `/team` endpoints and comparison UI | **ADAPT** ActivTrak master-detail | `routes/analytics.ts`, `analytics/reports/series.ts`, dashboard |
| E | `pg_cron` + `pg_net` scheduling three workers | **ADOPT** | migration `...0008` |
| F | AI worker: correct numbers, upsert, structured JSON, weekly + insight | **ADOPT** | `ai-summary-worker`, migration, `routes/analytics.ts`, `/insights` |
| G | `/reports` and `/insights` pages | **ADAPT** Cattr's run/download split | `app/reports/`, `app/insights/`, `lib/api.ts`, `store/filters.ts` |
| — | Export watermarking (`markAsExported`) | **REJECT** — invoicing device; a mutable flag on a hot append-only table | — |
| — | XLSX | **REJECT** — §5 names CSV and PDF | — |
| — | Saved report templates / report builder | **PHASE 2** | — |
| — | Scheduled email delivery | **PHASE 2** | — |
| — | Productivity goals / expected hours | **PHASE 2** | — |
| — | Active/Passive engagement split | **PHASE 2** — agent workstream | — |
| — | `pgmq` | **REJECT** — forbidden, and `status='pending'` is the queue | — |
| — | An Audit Log report (Hubstaff ships one) | **REJECT** — reads as compliance tooling, §8 Later | — |
