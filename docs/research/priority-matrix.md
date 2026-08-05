# Priority matrix

> Every recommendation from the five research documents, in one place, sorted by how
> much it raises the product toward industry standard **per unit of work**.
> Read this first; read the area document for the reasoning.

---

## How to read this

**Effort** — one developer already fluent in this repo.
**S** ≤ half a day · **M** 1–2 days · **L** 3+ days.

**Demo impact** — how much the client notices on demo day.
**H** — they will see it, or they will see its absence.
**M** — it makes an existing screen credible rather than adding one.
**L** — correctness or performance the client cannot see but the numbers depend on.

A low demo impact is not a low priority. Three of the four cheapest items in the top
table are **L** impact, and they are first because a demo built on wrong numbers fails
the moment someone checks the arithmetic in front of the client.

**Verdict** — **ADOPT** take the reference's approach · **ADAPT** take the idea, change
the mechanism · **REJECT** considered and declined, reason recorded · **PHASE 2** good
idea, outside `docs/scope.md`.

**Sequencing note.** `apps/desktop-agent` is being edited by another workflow. Anything
touching it must be sequenced behind them.

---

## Before the client demo

Ordered by value per unit of work. Everything here maps to a locked scope clause.

| # | Recommendation | Scope | Effort | Demo | Our files | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Reconcile the idle-threshold default.** `DEFAULT_IDLE_THRESHOLD_SECONDS = 300` vs the policy column's `default 120`. The comment claiming they match is the bug. | §2.6 | **S** (5 min) | L | `desktop-agent/src/main/collector.ts:27` | ADOPT |
| 2 | **Order + limit the analytics queries.** Four `.select("*")` with no `.order()` and no `.limit()`; PostgREST caps at 1000 rows silently and non-deterministically. A real 8-hour day passes 1000 focus intervals. Return `truncated: boolean`. | §2.7, §2.2 | **S** (~1 h) | L | `apps/api/src/routes/analytics.ts:77-107` | ADOPT |
| 3 | **`powerMonitor` suspend / resume / lock hooks.** A closed lid for three hours currently flushes ONE activity event spanning the whole sleep, counted as tracked *and* active. ActivityWatch has no suspend handling at all — this is where we beat the reference. | §2.2, §2.6 | **S** (~2 h) | M | `desktop-agent/src/main/index.ts:458`, `collector.ts` (`suspend()` mirroring `pause()` at `:283-301`) | ADOPT |
| 4 | **Idle in `/live`.** `StatusDot` already renders three states; `/live` computes only `active \| offline` and never reads `idle_events`. §4.3 shows the amber row literally. | §4.3 | **S** (~2 h) | **H** | `routes/analytics.ts:206`, `admin-dashboard/src/lib/api.ts:17` | ADOPT |
| 5 | **Schedule the workers.** `pg_cron` 1.6.4 and `pg_net` 0.20.4 are available and uninstalled; nothing in the repo schedules anything. §6's "daily" and "weekly" are schedule words. | §6, §5 | **S** (~4 h) | M | `supabase/migrations/…0008_schedules.sql` | ADOPT |
| 6 | **Auth shell.** No middleware, no `/login`, no session, no sign-out. A 401 currently renders as "check that the API is running". Blocks everything below it. | §4 preamble, stack §6, NN#3 | **M** (~1 d) | **H** | `middleware.ts`, `app/login/`, `lib/session.ts`, `app-shell.tsx`, `lib/api.ts:58-73` | ADOPT |
| 7 | **Employee detail page — layout + Overview + Timeline tab.** `/people/:id` is linked from two screens and 404s; §4.4's seven sections are 0/7; `ActivityTimeline` has zero importers. **This is the demo.** Tabs as nested routes, range in the query, per ActivityWatch's URL-as-state. | §4.4 | **M** (~1 d for these three) | **H** | `app/(app)/people/[profileId]/{layout,overview,timeline}` | ADOPT |
| 8 | **Server-side timeline reduction.** New `timeline.ts`: `floodGaps(5s)`, `mergeAdjacent`, `clusterShort` (absorb, never discard), `dayGrid(600s)`. Also fixes `buildTimeline` being O(slots × events) with `rankApps` inside the loop. Without `mergeAdjacent` a 2-hour VS Code session renders as 24 seams, because the agent caps intervals at 5 minutes. | §2.7 | **M** (~1.5 d) | **H** | `packages/analytics/src/timeline.ts` (new), replacing `productivity.ts:93-133` | ADOPT principle / ADAPT rules |
| 9 | **Widen `TimelineEntry` + add `TimelineMarker`.** §2.7's spec is a list of *moments* (`09:00 Login`, `10:00 Screenshot`); a pure span type cannot express one line of it. Also unblocks the 4 declared-but-dead event kinds in `activity-timeline.tsx:9`. | §2.7 | **S** to write, **M** to land | M | `packages/types/src/dto.ts:150-159`, then analytics + SDK + dashboard together | ADAPT |
| 10 | **Two-layer timeline render: SVG ribbon + event rail.** Proportional width, 5%-of-span label rule, 60-second minimum *rendered* width. Gaps render as hatched segments instead of being filtered out. Reject vis-timeline and Fabric — design.md says "Custom event timeline". | §2.7, §2.6 | **L** (~3 d incl. a11y + both themes) | **H** | `components/activity-timeline.tsx` | ADAPT render / REJECT libs |
| 11 | **Activity level %.** Per-second `getSystemIdleTime() === 0` over a wall-clock-aligned 600s grid; send counts, derive the percentage server-side, weight by `sampledSeconds`. §6's own example reads `Productivity: 86%` and nothing in the codebase can honestly produce it — `productivityRatio` is a ratio of *tracked* time and returns 1.0000 for an 8-hour read. | §2.2, §2.7, §4.1, §5, §6 | **M** (~1.5 d) | **H** | `main/activity-level.ts` (new), `collector.ts`, `persistence.ts`, `dto.ts`, migration `…0007`, `routes/activity.ts`, `analytics/activity-level.ts` | ADOPT metric / ADAPT segmentation |
| 12 | **Categorisation rule engine (M1: engine + schema + wiring).** Ordered list, first match wins, per-field regex ANDed, suffix-aware domains, tri-state productivity, `Uncategorized → neutral`. Applied at ingestion *and* optionally at read time so a new rule relabels history with no backfill. Today every `activity_events.category` is NULL because the agent never sets it. | §2.4, §2.5, §4.4, §5, §6 | **M** (~1 d) | **H** | `packages/analytics/src/categorize.ts` (new), migration `…0008`, `routes/activity.ts`, `productivity.ts` | ADAPT |
| 13 | **Postgres-side aggregation via multiranges.** `range_agg` minus `range_agg` is `merge()` minus `difference()` in the database. Kills the 1000-row cap for reports too. Port `productivity.test.ts:50-149` to pgTAP so the SQL and the TS are proven to agree. **Spike the multirange difference first — inferred from docs, not executed.** | §5, §6 | **L** (~3 d) | L | migration `…0007_report_aggregates.sql`, `routes/analytics.ts`, both workers | ADOPT (own defect) |
| 14 | **Renderer seam + PDF.** One `ReportDocument`, N renderers, chosen by `report.format`. `pdf-lib` (Deno-safe; `pdfkit` trips a blocklisted `Deno.readFileSync`). Harden the CSV in the same pass: BOM, CRLF, quote every field, formula-injection guard. **§5 names PDF and we have none.** | §5 | **M** (~2 d) | **H** | `report-worker/{document,renderers/*}`, `routes/reports.ts:5-10`, `dto.ts` | ADOPT Kimai's seam |
| 15 | **Four real report types.** `kind` currently changes only the filename — daily, weekly and team produce byte-identical CSVs. Time & Activity, Apps & URLs, Website Usage, Work Breaks, each with enumerated groupings and a totals row. `break_events` is collected and read by nothing. | §5, §2.2 | **M** (~1.5 d) | **H** | `analytics/reports/*`, `report-worker`, `routes/reports.ts` | ADAPT Kimai / ADOPT Hubstaff grouping |
| 16 | **Screenshots: all per block + batch-signed URLs.** `.find()` returns one screenshot per bucket; at §2.3's 1-minute option that discards 59 of 60. `TimelineEntry.screenshotId` has no URL and the bucket is private. | §2.3, §2.7 | **M** (~1 d) | **H** | `productivity.ts:115`, `routes/analytics.ts:109-118`, `dto.ts`, `sdk/client.ts:166` | ADOPT |
| 17 | **Screenshot review UI.** One row per 10-minute block, thumbnails lazy-loaded, monitor badge, explicit "No capture" cells, lightbox with keyboard nav. Active/idle split in words, never a bare %. | §2.3, §4.4 | **M** (~2 d) | **H** | `components/screenshot-review.tsx`, `people/[profileId]/screenshots` | ADAPT Cattr / ADOPT Apploye block / REJECT their gallery |
| 18 | **Thumbnails.** 280px q50 from the `NativeImage` we already hold (no new dependency). `thumbnail_path` exists and nothing writes or reads it; a 48-tile page goes from ~10 MB to ~400 KB. | §2.3, §4.4 | **M** (agent S, API M) | M | `main/screenshot.ts:221`, `routes/screenshots.ts:43` (must become multi-part) | ADOPT constants / ADAPT site |
| 19 | **Capture group + display identity.** `displayId` is documented as existing "so the timeline can label multi-monitor captures" and is never sent. One capture moment currently becomes N ungrouped rows. Reject Cattr's stitched composite. | §2.3, stack §10 | **M** (~1 d) | M | `screenshot.ts` (form-field order at `:133-137` is load-bearing), `routes/screenshots.ts:9`, migration `…0007` | ADAPT idea / REJECT composite |
| 20 | **AI worker: correct numbers + upsert + structured output + weekly.** Active time is currently the top-8 apps summed with no merge and no idle subtraction — it agrees with no other surface. No unique index, so re-running duplicates. `ai-insight.tsx` already declares `breakdown/observation/recommendation` and nothing produces them. `kind` is hardcoded `daily`; the check constraint already permits weekly and insight. | §6 | **M** (~1.5 d) | **H** | `ai-summary-worker/index.ts`, migration, `routes/analytics.ts` | ADOPT |
| 21 | **`/reports` and `/insights` pages.** Both are in the sidebar and both 404. Run-to-screen and Export-to-file as two buttons on the same filters. | §5, §6, §4.4 | **M** (~1.5 d) | **H** | `app/(app)/reports/`, `app/(app)/insights/`, `lib/api.ts` | ADAPT Cattr's split |
| 22 | **`/activity` master–detail.** Roster left, selected person's timeline right, no navigation, selection in the URL. Reuses `ActivityTimeline` unchanged. Also kills a sidebar 404. | §4.1, §4.3 | **M** (~1 d) | **H** | `app/(app)/activity/page.tsx` | ADOPT ActivTrak / ADAPT Cattr |
| 23 | **Range control + filters + URL state.** `range`, `department` and `resolveRange()` all exist with zero readers; every screen is implicitly "now", which makes §5 unusable from the UI. Demote Zustand to defaults, read from `useSearchParams`. | §5, §4.1 | **M** (~1 d) | M | `components/range-picker.tsx`, `store/filters.ts`, `people/page.tsx` | ADOPT AW's control set |
| 24 | **Remaining five detail tabs** — Screenshots, Apps, Websites, Reports, Devices. Every endpoint already exists and returns the right shape. | §4.4, §2.4, §2.5, §7 | **S each** (1–2 h) | **H** | `people/[profileId]/*` | ADOPT |
| 25 | **Role-aware nav.** `NAV` is a `const` array rendered unconditionally; an employee sees Devices, Reports and AI Insights. Kimai gates every menu item on a named grant. | §4, NN#3 | **S** (~2 h) | M | `app-shell.tsx:20` | ADOPT |
| 26 | **Work-pattern block replacing the bare score.** `docs/design.md:176-182` specifies *Focused Time / Collaboration / Idle* and no function could produce those lines. **Strictly after #12** — before the rule engine everything folds into Uncategorized. | §4.4, §6 | **S** (~2 h) | **H** | `productivity.ts`, Overview tab | ADAPT (design.md) |
| 27 | **`sampleFocus` outage becomes a gap.** `collector.ts:192-199` returns on error *before* `rollLongInterval`, so a 200-second adapter failure is attributed to the app focused before it. | §2.2, §2.7 | **S** (~1 h) | L | `collector.ts:189-199` | ADOPT |
| 28 | **Title normalisation.** Strip `^\(\d+\)\s*` unread badges and `^[●*]\s*` dirty markers on the agent. Shrinks what leaves the machine and stops title-based rules fragmenting. | §2.4, §2.7 | **S** (~1 h) | L | `tracker.ts:186` | ADOPT |
| 29 | **`/settings` page.** Company, policy version, screenshot interval, idle threshold, per-employee monitoring toggle. §4.2's "enable/disable monitoring" has no UI at all. | §4.2 | **M** (~1 d) | M | `app/(app)/settings/page.tsx` | ADOPT |
| 30 | **Screenshot capture as an enforced policy dimension.** `forbidden \| required \| optional`, company-level with a per-employee override only when the company value is optional; re-checked server-side per NN#1. Gives §4.2 a screenshot-level expression. **Re-run `rls_isolation.sql`** — new column on `profiles`. | §4.2, §2.3, NN#1 | **M** (~1 d) | M | migration, `routes/screenshots.ts:36`, `screenshot.ts:194`, settings UI | ADAPT |

---

## After the demo

Still in scope, still worth doing — just not what the client sees first.

| # | Recommendation | Scope | Effort | Demo | Our files | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 31 | **`/trend` and `/team` endpoints + comparison table.** §5's three team asks (comparison, trends, working patterns) from one response, with a sparkline column and an inline timeline drill. Needs #13 first. | §5 | **M** | M | `routes/analytics.ts`, `analytics/reports/series.ts` | ADAPT ActivTrak |
| 32 | **Categorisation M2: the settings UI.** Drag-to-reorder priority, RHF+Zod rule form, and a "test this rule against yesterday's events" preview. The preview is what makes it a rule engine rather than a config screen. Ship M1 without it if time is short; seed rules by migration for the demo. | §2.4, §2.5 | **M** | M | `settings/categories/page.tsx` | ADAPT |
| 33 | **`/me` employee transparency view.** Same tab components, `profileId` pinned to the session, plus the consent record and a revoke button. **~3 h if #7 built the tabs as routes; a rewrite if it did not.** Not a scope clause — serves NN#3 and design.md's third psychology layer, and is labelled as such. | NN#3 | **S** | M | `app/(app)/me/page.tsx` | ADOPT Kimai's one-feature-two-permissions |
| 34 | **Screenshot worker rewrite.** The orphan sweep is *unreachable* (`list("")` returns bucket children only, and `list` names are prefix-relative while `storage_path` is the full key). The linkage pass starves itself and does 500 sequential round trips. | stack §9, §2.3 | **M** | L | `screenshot-worker/index.ts` | ADAPT shape / REJECT current impl |
| 35 | **Subject timezone.** `profiles.timezone`; day boundaries and clock labels computed in the employee's zone, stated in the header. A manager in IST currently slices a PST employee's day at the wrong midnight. **Re-run `rls_isolation.sql`.** | §2.7, §5 | **M** | L | migration, `lib/format.ts:32`, `store/filters.ts:33` | ADAPT Cattr |
| 36 | **Zoom, pan and a shareable window on the timeline.** Wheel-unit normalisation and zoom-or-pan-never-both are the two details ActivityWatch already paid for; both feel broken if discovered independently. | §2.7 | **M** | M | `activity-timeline.tsx` | ADAPT contract, no library |
| 37 | **Device detail page + installed applications.** `device_applications` is written by `POST /api/devices/applications` and rendered by nothing. Datadog-inventory style per design.md. | §7 | **M** | M | `app/(app)/devices/[deviceId]/page.tsx` | ADOPT |
| 38 | **TanStack Table on People and Devices.** Installed and unused; the people search is an in-memory substring scan over the whole roster. | §4.2, §7 | **M** | L | `people/page.tsx`, `devices/page.tsx` | ADOPT |
| 39 | **Two-orthogonal-channel colour.** State on the ribbon fill, a deterministic app-identity hue on the label chip. Never `--accent` indigo — reserved for AI. Reject Apploye's red band. | §2.7 | **S** | M | `activity-timeline.tsx`, `globals.css` | ADAPT idea / REJECT palette |
| 40 | **Work-session read path.** `work_sessions` is written and read only inside the `/overview` aggregate; there is no GET, so an Overview tab cannot show "Work Started: 09:05 AM". | §2.2, §4.4 | **S** | M | `routes/activity.ts` or `employees.ts` | ADOPT |
| 41 | **Standalone app-usage endpoint.** `topApps` is buried in the productivity payload and hard-capped at 10 by `rankApps(..., limit = 10)`. §2.4 wants an app list as a first-class view. | §2.4 | **S** | M | `routes/analytics.ts` | ADOPT |
| 42 | **Exception strip on Overview.** "2 people idle over 45m today", "1 device offline since 09:20". Hubstaff's home answers *who needs my attention*; ours shows four totals. Shape only — **no `/alerts` route**, no scope clause supports one. | §4.1 | **S** | M | `app/(app)/page.tsx` | ADAPT shape / REJECT route |

---

## Phase 2 — outside `docs/scope.md`

Named so the team can see them being excluded rather than discover them missing. Each is
a client decision, not ours. **`docs/scope.md` closes with "Any feature outside this list
is Phase 2."**

| Recommendation | Why it is out | Effort if taken |
| --- | --- | --- |
| **Browser extension for Windows URL capture** | §2.5 asks for domain and time spent without naming a mechanism; `browser-url.ts` already satisfies it on macOS with real URLs and on Windows with a conservative title-derived domain. An extension is a second deliverable with a managed-policy deployment story. CLAUDE.md open item #6. | L |
| **Randomised capture offset inside the interval** | Both Apploye and Hubstaff do it, and our schedule is perfectly predictable today. §2.3 says "configurable interval", not "randomised within interval". Cheapest credibility win here and still a scope change. | S |
| **Device-side screenshot blur** | Not in §2.3, not on the §8 Later list — Phase 2 by the default rule. Blocked on either `sharp` (a native dependency the agent avoided deliberately) or a hidden `BrowserWindow`. The `blurred` column and DTO field are already wired, so the contract is ready. | M–L |
| **Screenshot retention** | No clause. Flagged now as a cost fact: **~0.7–1.0 GB per employee per month, unbounded**. Cattr's disk-pressure thinning does not transfer — Supabase bills per GB and has no disk that fills. Age-based per company if taken. | M |
| **Screenshot deletion and flagging** | No clause. Deliberately *not* argued under §8 "advanced compliance", which is Later. The real motivation is incident response: a shot that caught a password manager has no removal route today (RLS is SELECT-only, so the current posture is safe-by-default). | M |
| **Saved report templates / report builder** | Genuinely the best idea in either reference codebase (Cattr's universal reports, Kimai's export templates) and genuinely out of scope. §5 asks for report *types*. | L |
| **Scheduled report email delivery** | §5 says "Export: CSV, PDF" and stops. Adding an email pipeline is scope creep. Take only their relative date-range vocabulary now. | M |
| **Productivity goals / expected hours** | ActivTrak's `actual / expected` framing fits `docs/design.md`'s "prefer work patterns over a score" better than anything else found, and has no basis in `docs/scope.md`. | M |
| **Active / Passive engagement split** | ActivTrak's second axis. Needs a second, shorter threshold in the agent — tracker/idle workstream, not this one. | M |
| **Month-calendar navigator** | §2.7 and §4.4 describe a *day*. Real work for a demo that shows one day. | M |
| **Cross-employee timeline swimlanes** | §5 covers comparison via *reports*, not a shared timeline canvas. | L |
| **`/alerts` route** | No clause supports it; §8 keeps advanced work out. The exception strip (#42) gets the value without the route. | M |
| **XLSX export** | §5 names CSV and PDF. The renderer seam makes it a one-file addition whenever asked for. | S |
| **Permanent SQL backfill of `activity_events.category`** | Read-time recategorisation covers the need. A backfill is a data-migration decision. | M |

---

## Rejected

Considered and declined. Recorded so the argument is not had twice.

| Recommendation | Reason |
| --- | --- |
| **Heartbeats + `pulsetime` ingestion** (ActivityWatch) | The crash-durability argument is already answered by `persistence.ts`'s append-only journal. Adopting it means one UPDATE per heartbeat against Supabase Postgres and moves idempotency off `client_event_id`, which the unique indexes, the upserts and the journal are all built on. Their own server merge carries a `FIXME` conceding it can overwrite a newer event, and the Python negative-duration guard tests the wrong variable. **Closed — see `activity-engine.md` §2.** |
| **`iohook` / `uiohook-napi` / any global keystroke hook** | A per-platform native prebuild, macOS Accessibility required, and a keystroke listener in a product whose first design rule is "not surveillance". `getSystemIdleTime()` gives the same metric for free. |
| **Categorising on the agent** | Rules are company data that changes without a release; agent-side would have to be rebuilt for Android and again for a Phase 2 Tauri agent. Delete or document `ActivityEventInput.category` and `AgentPolicy.trackedCategories` — a field the API ships that nothing reads is a lie in the contract. |
| **Cattr's activity-proof modal** ("Are you still working?") | The most surveillance-coded interaction in any reference, and stopping the tracker on timeout silently loses work time. |
| **Cattr's stitched multi-monitor composite** | A 3840×1080 JPEG is illegible at review size, doubles the bytes of every moment, and makes "which monitor" unanswerable forever. |
| **Cattr's `Screenshots.vue` flat gallery** | Exactly what `docs/design.md` forbids. Their `Timeline.vue` master-detail is the pattern; the gallery is the anti-pattern, in the same codebase. |
| **vis-timeline / Fabric.js** | `docs/design.md`'s design system says `Timeline | Custom event timeline`; CLAUDE.md forbids a library duplicating something already listed. A day of merged spans is a few hundred `<rect>`s. |
| **Apploye's red/yellow/green activity bands as the primary encoding** | A red block beside a person's name is the surveillance framing the positioning rule forbids. Emerald / amber / muted, and the number in the tooltip. |
| **`--accent` indigo anywhere in the timeline** | Reserved for AI surfaces so a reader can tell model output from recorded fact. |
| **Editing or annotating events from the timeline** | Out of scope and fights NN#5 — manager-editable activity data destroys the evidentiary value of the record. |
| **Kimai's export watermarking (`markAsExported`)** | An anti-double-invoicing device. We are not billing, and it would add a mutable flag to `activity_events`. |
| **`pgmq`** | Available on the project, forbidden by CLAUDE.md, and unnecessary — `reports.status = 'pending'` already is the queue. |
| **An Audit Log report** (Hubstaff ships one) | Reads as compliance tooling; §8 puts advanced compliance out of the MVP. |
| **Configurable / drag-reorderable dashboard widgets** | Needs a preferences table and a drag library; `docs/design.md` warns against a card farm. One fixed, well-argued Overview beats 26 widgets. |
| **Project / task / client dimension in filters** | Not in the schema, not in scope. A filter that filters nothing is worse than no filter. |
| **Per-view timezone selector** | Single enterprise client, one timezone. Record the assumption; build the *subject* timezone column (#35) instead. |
| **Hubstaff's two-level sidebar** | `docs/design.md` picked a minimal flat sidebar. Not reopened. |
| **Location tracking, remote control, file monitoring, USB control, software deployment, MDM, endpoint protection, SSO, advanced compliance** | NN#6 and `docs/scope.md` §8. Nothing in these documents touches any of them. |

---

## The short version

**If only four things get done, do 1, 2, 3 and 4.** They cost under a day in total and
they are the difference between numbers that are wrong and numbers that are right: a
five-minute-versus-two-minute idle threshold, a silent 1000-row truncation that a real
working day already exceeds, a three-hour laptop sleep counted as active work, and a
live status that can never show the amber row §4.3 puts in the specification.

**If the demo is close, the minimum credible cut is 1–12 plus 14, 15 and 21** — about
seven days. That is: correct numbers, a working login, an employee page whose timeline
actually renders, an activity percentage the AI summary can quote, categories the app
list can group by, both export formats §5 names, and a reports page that is not a 404.

**The two items the product cannot credibly stand next to Apploye or Hubstaff without
are #11 (activity level) and #12 (categorisation).** Everything else is polish on top of
a real product or correctness underneath one. Those two are the product.
