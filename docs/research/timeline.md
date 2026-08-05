# Activity timeline

> The employee day view. Serves `docs/scope.md` §2.7 and §4.4, and §2.3's "screenshot
> timeline".
> `docs/design.md` calls the timeline + AI insight pairing "the killer design feature"
> and instructs spending effort here before anywhere else.

Read source: ActivityWatch `aw-webui` (`VisTimeline.vue`, `visualizations/timeline-simple.ts`,
`util/color.ts`, `queries.ts`) and `aw-core` (`aw_transform/flood.py`, `simplify.py`) at
`master`; Cattr `frontend-application` (`TimelineDayGraph.vue`, `TimelineCalendarGraph.vue`)
at `main`. Vendor documentation: Apploye, Hubstaff, ActivTrak.

---

## 1. The through-line

Four things every credible implementation does that we do none of:

1. **Reduction happens on the server**, before the browser sees an event. ActivityWatch
   floods gaps, merges by key, sorts, and then caps at 100 events — thirteen separate
   `limit_events(…, 100)` calls across their query definitions.
2. **A fixed, shared time unit.** Apploye and Hubstaff hang the screenshot, the activity
   ratio and the app list off the same 10-minute cell; Cattr maps the day onto exactly
   24 columns. That shared unit is why their three views line up.
3. **An explicit subject timezone.** Cattr passes `timezone` as a prop converted from
   company settings; the graph never trusts the viewer's clock.
4. **A minimum renderable width**, so a short event stays hoverable and clickable.

Everything below elaborates one of those four.

---

## 2. Reduction — `flood`, and the query pipeline

**VERIFIED — `aw-core/aw_transform/flood.py`.** Default `pulsetime = 5` seconds,
negative-gap trim threshold 0.1 seconds. Deep-copy, sort by `(timestamp, duration)`,
walk adjacent pairs:

| Gap between neighbours | `data` equal | Action |
| --- | --- | --- |
| Negative, within 0.1s | either | Treated as zero |
| Negative, beyond 0.1s | yes | Merge into `[min(start), max(end))`, zero the second |
| Negative, beyond 0.1s | no | Warn once per batch, do nothing |
| `(-0.1s, pulsetime]` | yes | The **longer** neighbour absorbs the gap; the shorter is zeroed |
| `(-0.1s, pulsetime]` | no | **Split at the midpoint** — each extends to `e1.end + gap/2` |

A final normalisation pass drops zero-duration events and resolves residual overlaps
with "the later event wins". Their justification for the midpoint rule is the part
worth keeping: the gap is an interval of uncertainty, and splitting it evenly is
independent of the surrounding event lengths — i.e. it is the only rule that does not
systematically favour long events over short ones.

**VERIFIED — `aw-webui/src/queries.ts`.** The full desktop pipeline, in order:

```
events   = flood(query_bucket(window_bucket))          # 1. fill sub-5s jitter
not_afk  = flood(query_bucket(afk_bucket))
not_afk  = filter_keyvals(not_afk, "status", ["not-afk"])
not_afk |= period_union(filter_keyvals_regex(events, "app", always_active_pattern))
not_afk |= period_union(filter_keyvals(browser_events, "audible", [true]))
events   = filter_period_intersect(events, not_afk)    # 2. the ONLY idle removal
events   = union_no_overlap(stopwatch_events, events)  # 3. manual overrides automatic
events   = categorize(events, classes)
title_events = sort_by_duration(merge_events_by_keys(events, ["app","title"]))
app_events   = sort_by_duration(merge_events_by_keys(title_events, ["app"]))
cat_events   = sort_by_duration(merge_events_by_keys(events, ["$category"]))
limit_events(app_events, 100); limit_events(title_events, 100)
```

Three details worth naming:

- **The idle mask is positive.** It is a list of `not-afk` spans, and window events are
  *clipped* to it. Idle is never subtracted from a total; it simply never enters the
  stream. `filter_period_intersect` is a two-pointer walk that keeps the source event's
  `data`, discards the filter event's, and **can emit one source event several times** —
  once per intersecting mask span. That last property is the point: a four-hour VS Code
  event straddling three idle gaps becomes four shorter VS Code events.
- **`period_union` strips all data** from its results, with the docstring conceding it
  "cannot keep it consistent". It is a mask-building primitive, not a merge.
- The `always_active_pattern` and `include_audible` widenings are how a video call or a
  media player counts as active with no keyboard input. That is a real product problem
  we have not thought about.

**VERIFIED — `merge_events_by_keys`.** Builds a composite tuple key from the requested
`data` keys, present ones only; the first event of a group donates its timestamp and
duration and subsequent ones add to the duration. Output is unsorted, and the docstring
says outright that the timestamp on a merged event is meaningless residue.

**VERIFIED — `aw-webui/VisTimeline.vue`.** Their density control is blunt and honest:
`filterShortEvents` drops every event with `duration <= 1` second, with a TODO
admitting "Use flooding instead, preferably with some additional method of
removing/simplifying short events for even greater performance."

### What we do today

`packages/analytics/src/productivity.ts:93-133` `buildTimeline` slices the window into
fixed `bucketSeconds` slots and, **inside the slot loop**, re-clamps every activity and
idle event (`:104-111`) and calls `rankApps(input.activity, slot, 1)` over the *entire
day's* activity (`:113`) — and `rankApps` internally calls `totalSeconds` → `merge` →
a sort, per app, per slot. The route permits `bucketSeconds` down to 60
(`apps/api/src/routes/analytics.ts:12`), i.e. 1,440 slots. Benchmark 2,000 events at
`bucketSeconds: 60` against `3600`: roughly sixty times the work for the same day.

There is no gap bridging of any kind. There is no equivalent of `flood`, no adjacent-run
collapse, and no short-event handling.

The consequence nobody has connected yet: `apps/desktop-agent/src/main/collector.ts:21`
sets `MAX_ACTIVITY_INTERVAL_MS = 5 * 60_000` and `rollLongInterval()` (`:214-221`)
closes and reopens at the same instant. **A two-hour VS Code session arrives as 24
separate rows.** Without adjacent-run collapse the ribbon shows 24 artificial seams
inside one continuous stretch — a rendering artefact created entirely by an agent
decision.

### Recommendation — R2

**ADOPT server-side reduction as an architectural principle.**

New `packages/analytics/src/timeline.ts`, exported from the package index, replacing the
per-slot rescan. One pass over sorted spans, O(n log n) total:

```
sortAndClip(spans, window)                     // once, not per slot
floodGaps(spans, pulseSeconds = 5)             // ADAPT aw_transform/flood.py
mergeAdjacent(spans, keyOf)                    // ADAPT merge_events_by_keys(["app","title"])
clusterShort(spans, minSeconds = 60)           // ADAPT, with one deliberate difference
dayGrid(spans, markers, slotSeconds = 600)     // ADOPT the shared unit
```

- **`floodGaps` at a 5-second pulse.** Not coincidentally our own `TICK_INTERVAL_MS`
  (`collector.ts:18`). A 1–4 second hole between two focus intervals is sampling jitter,
  not idleness; rendering it as a hairline gap makes the ribbon look moth-eaten.
  Same-key neighbours merge; different-key neighbours each extend to the midpoint.
- **`mergeAdjacent` is not optional** — see the 24-seams problem above.
- **`clusterShort` — deliberately diverge from ActivityWatch.** They drop
  `duration <= 1` outright. We must not: those seconds are tracked working time and
  dropping them makes the ribbon disagree with the KPI row. Instead, a run of
  consecutive sub-minute spans collapses into one synthetic span
  `{ kind: "switching", seconds, appCount, topApps }` that **keeps its full duration**
  and renders as a hatched "rapid switching · 7 apps · 3m". Absorb, never discard. Prove
  it with a test asserting total seconds are conserved.
- **`dayGrid` at 600 seconds** as the one unit shared by the ribbon, the screenshot
  strip and the app list. This is the single most valuable structural idea in the whole
  survey.

Each slot yields
`{ start, end, activeSeconds, idleSeconds, breakSeconds, offlineSeconds, activityRatio, topApps, screenshots[] }`.

**REJECT their `always_active_pattern` / `include_audible` widenings for the MVP** —
they depend on a browser extension reporting `audible` and on a user-editable pattern
list, neither of which we have. Record the idea: a video call counting as active with
no input is a real problem, and R1 in `activity-engine.md` measures input density
rather than presence, which mitigates it partially.

---

## 3. Proportional rendering — 60 lines of SVG, no library

**VERIFIED — `aw-webui/src/visualizations/timeline-simple.ts`.** A `viewBox` of
`0 0 100 4` at `width: 100%`. Position and width are pure ratios:
`x = (timestamp - first) / total_duration`, `width = 100 * duration / total_duration`,
group translated by `translate(100 * x, 0)`. Hover darkens the base colour.

The label rule is the important bit: **text is appended only when
`duration > 0.05 * total_duration`** — a 5%-of-visible-span threshold — with a `<title>`
child carrying timestamp, duration and the serialised data for everything else. No
library, no canvas, no virtualisation, and it renders a full day.

**VERIFIED — Cattr `TimelineDayGraph.vue`.** A Fabric.js canvas mapped onto exactly 24
time columns. `columnWidth = canvasWidth / 24`; an interval's left is
`floor(hoursSinceDayStart * columnWidth)` and its width is
`((max(duration, 60) + 120) * columnWidth) / 3600`. Two things there are smarter than
they look: a **60-second floor** on duration and a **+120-second visual pad**, so a
12-second interval is still wide enough to hover and click. Colour is *state*, not
identity — one colour for manual entries, another for automatic. They do **no**
clustering or merging of adjacent intervals at all, which is where they are weaker than
ActivityWatch.

**VERIFIED — `VisTimeline.vue` interaction contract.** `zoomMin` one minute, `zoomMax`
about three months, `stack: false`, `horizontalScroll: true`, tooltip follows the mouse
with `overflowMethod: 'flip'` and zero delay. There is a hand-written horizontal-wheel
handler registered with `{ capture: true, passive: false }` that pans by
`(deltaX / 120) * ((end - start) / 20)` and normalises wheel units with 40 pixels per
wheel *line* and 800 per *page*. Their comment explains why a `preferZoom` flag exists:
without it the library zooms around the cursor and then pans on the same wheel event,
"which makes the zoom anchor drift". That is a bug we would otherwise discover ourselves
in week two.

### What we do today

`apps/admin-dashboard/src/components/activity-timeline.tsx:44` renders a single
continuous rail — `<ol className="relative">` at `:57`, one `<li>` per event at `:63`,
the connecting hairline at `:66-71`, screenshots attached inline to their event at
`:106-113` rather than in a separate gallery. The docstring at `:33-43` states the
correct thesis: *"the thing a manager is reading is the shape of the day: where the
gaps are."*

Every `<li>` is the same height (`pb-5`) regardless of duration. A four-hour VS Code
stretch and a fifteen-second Slack peek are identical marks. There is no time axis, no
window state, no wheel or brush handling anywhere in the file.

And it is mounted nowhere: grep across `apps/admin-dashboard/src` finds zero importers
for `ActivityTimeline` or `bucketsToEvents`. The centrepiece is a dead component behind
a 404 — `people/page.tsx:115` and `live-workforce.tsx:78` both link to
`/people/${id}`, and `apps/admin-dashboard/src/app/people/` contains only `page.tsx`.

### Recommendation — R5

**ADAPT the rendering. REJECT the libraries.**

Two layers in `activity-timeline.tsx`:

**Layer A — the day ribbon.** One inline
`<svg viewBox="0 0 1440 32" preserveAspectRatio="none" width="100%">`, one `<rect>` per
merged span, `x = minutesFromWindowStart`, `width = durationMinutes`,
`shape-rendering="crispEdges"`. This is ActivityWatch's normalisation in minute units
instead of percent units.

- **ADOPT their 5% label rule** — render the app name inside a rect only when its width
  is at least 5% of the visible span; everything else lives in the tooltip.
- **ADOPT Cattr's minimum-width floor** — clamp the *rendered* width to a 60-second
  equivalent so a 15-second span stays hoverable. **Clamp the rendered width only,
  never the duration used for totals.** Cattr's `max(duration, 60) + 120` inflates their
  pixels; that must not leak into arithmetic.

**Layer B — the event rail.** Keep the existing `<ol>`, but fed `TimelineMarker[]` and
clustered spans rather than raw buckets. Keep the inline screenshot at `:106-113`; swap
`src` to `thumbnailUrl` with the full image behind a click. Delete `bucketsToEvents`
(`:123-135`) — the reduction now lives in `packages/analytics`.

**REJECT vis-timeline and Fabric.js as dependencies.** `docs/design.md`'s final design
system table says `Timeline | Custom event timeline`, and CLAUDE.md forbids adding a
library that duplicates something already listed. A day of merged spans is a few hundred
`<rect>`s — comfortably inside SVG's budget — and it keeps us out of canvas hit-testing,
which is the tax Cattr pays for using Fabric.

### Recommendation — R7, zoom and pan

**ADAPT vis-timeline's interaction contract without the library.**

Hold `[windowStart, windowEnd]` in component state, synced to `?from=&to=` so a manager
can paste a link to 14:05–14:20 into a report. Wheel zooms about the cursor;
`shift+wheel` or trackpad `deltaX` pans; drag on the ribbon brushes to zoom; Escape
resets to the full day. `zoomMin` 60,000 ms (their value); `zoomMax` one day, since this
is a single-day surface.

Take their two hard-won details: **one wheel event does either zoom or pan, never both**
(or the anchor drifts), and **normalise wheel units** — trackpads and mice report in
different units and ignoring that makes zoom feel broken on exactly one of the two.
Respect the existing `prefers-reduced-motion` block in `globals.css` by disabling zoom
animation.

---

## 4. Colour

**VERIFIED — `aw-webui/src/util/color.ts`.** Identity colour is deterministic: a
classic 32-bit string hash (`hash = (hash << 5) - hash + charCode`), reduced modulo 20,
fed into an ordinal scale over four pastels pre-warmed across a 0–20 domain. A
`customColors` table overrides known names. Category colour resolves by walking **up**
the category path array to the nearest ancestor carrying a colour, with a grey fallback.

Crucially, the string they categorise on is `data.app + "\n" + data.title` — the newline
is deliberate so `^` and `$` work per line under the multiline flag.

**DOCUMENTED — Apploye.** Activity ratio banded red 0–30 / yellow 30–60 / green 60–100.

### What we do today

`activity-timeline.tsx:26-31` is a static four-entry tone map onto the
`apps/admin-dashboard/src/app/globals.css:39-45` tokens. There is no per-app identity
colour, so ten different apps render identically. Category colouring is impossible:
`activity_events.category` is always null because the agent never sets it (grep of
`apps/desktop-agent/src/main/` for `category` returns nothing), and `rankApps`
propagates that null.

### Recommendation — R6

**Two orthogonal channels. ADAPT ActivityWatch's idea; REJECT their palette and
Apploye's bands.**

- **State — the ribbon fill, the primary encoding.** Active → `--success` emerald,
  idle → `--warning` amber, break → `--muted`, offline/no-data → transparent with a
  hatched 1px border, screenshot → a tick on the axis rather than a fill. **Never
  `--accent` indigo** — `docs/design.md` reserves it for AI output so a reader can tell
  model output from recorded fact.
- **Identity — the app label chip, secondary.** A deterministic hue from a 32-bit hash
  of `app_name` mapped into a fixed 8-hue ramp at fixed saturation and lightness. This
  is their *idea*, written fresh. Do not port their override table or their four-pastel
  scale: it is MPL-2.0 source data and those pastels are illegible on `#020617`.
- **REJECT Apploye's red/yellow/green bands as the primary encoding.** CLAUDE.md's
  design rules say to prefer descriptive work patterns over a bare percentage, and a red
  block beside a person's name is exactly the surveillance framing the positioning rule
  forbids. Keep the ratio as a number in the tooltip and in the Work Pattern readout.
- **Colour-by-category is blocked and belongs to another area.** Design the ribbon so
  category can become a third channel later — a thin underline stripe — but do not build
  it here. See `activity-engine.md` §5.

---

## 5. The route is silently wrong

Three separate defects, all in `apps/api/src/routes/analytics.ts:77-107`.

**Silent 1000-row truncation.** Four `.select("*")` calls with **no `.order()` and no
`.limit()`**. Supabase's hosted PostgREST `max-rows` defaults to 1000 (and
`supabase/config.toml:10` sets the same locally), and with no ORDER BY the response is
capped *and* non-deterministic in which 1000 rows arrive. The agent ticks every 5
seconds and force-closes any focus interval at 5 minutes, so an 8-hour day has a
**floor** of about 96 activity rows from the interval ceiling alone and, with realistic
window switching, passes 1000 well before the day ends. Seed 1,200 events for one
profile-day, call the endpoint, sum `activeSeconds`: it is short, with no error and no
flag.

This is the highest-value-per-minute fix in this document. It is a five-line diff and
it is the difference between a timeline that is wrong and a timeline that is right.

**Screenshots and sessions are dropped.** `productivity.ts:115` uses `.find(...)` — one
screenshot per slot. `TimelineInput` (`:85-90`) accepts only activity, idle and
screenshots; `work_sessions` and `break_events` both exist in the schema
(`20260805000004_inventory_and_tracking.sql:46-63` has a generated `duration_seconds`)
and neither is queried. Scope §2.7's worked example literally opens with `09:00 Login`,
and §2.2 requires break time as a first-class number.

**`deviceId` is a fiction when a person has two devices.** `analytics.ts:100-106` picks
the single most-recently-seen device and stamps its id onto every entry
(`productivity.ts:121`), even though the underlying events may come from a laptop *and*
an Android phone. `intervals.ts:27 merge()` correctly de-duplicates the overlapping
seconds, but the attribution is then wrong. ActivityWatch solves this structurally with
one timeline row per bucket — per watcher, per host.

### Recommendation — R4

**ADOPT all four sub-items.**

1. Add `.order("started_at", { ascending: true })` and an explicit `.limit(5000)` to
   each query, and replace `.select("*")` with the columns actually used. Return
   `truncated: boolean` when a cap is hit so the UI says "showing the first N events"
   rather than quietly lying.
2. Add `work_sessions` and `break_events` to the `Promise.all`.
3. Sign screenshot URLs **in this handler** with one `createSignedUrls` call —
   `routes/screenshots.ts:158-163` is already the exact code shape to mirror. One batch
   call, never N+1 from the browser.
4. Constrain `bucketSeconds` (`:12`) from a free 60–86,400 range to a fixed set
   `{60, 300, 600, 1800, 3600}` defaulting to **600**, so the ribbon, the screenshots
   and the apps list can never disagree about the grid. Then update
   `packages/sdk/src/client.ts:165-169` to accept and forward it — today every SDK
   caller is pinned to the default.

---

## 6. Markers — scope §2.7 is a list of moments, not a list of spans

This is the finding that changes the type, so it is worth stating on its own.

Scope §2.7's specification is:

```
09:00 Login
09:15 Chrome Active
09:40 VS Code Active
10:00 Screenshot
10:30 Idle
10:45 Active Again
```

Every one of those lines is an *instant*, not an interval. `TimelineEntry`
(`packages/types/src/dto.ts:150-159`) is a pure span model and **cannot express a single
line of that example.** `activity-timeline.tsx:9` already declares four event kinds —
`session-start | app | screenshot | idle` — and its only producer, `bucketsToEvents`
(`:123-135`), emits solely `"app"` or `"idle"` and never sets `screenshotUrl`. The
`Play` and `Camera` icons and the entire inline-screenshot branch are dead code because
the type upstream of them has nowhere to put a moment.

### Recommendation — R3

**ADAPT.** Widen the contract in `packages/types/src/dto.ts`:

```ts
// TimelineEntry gains:
breakSeconds: number;
offlineSeconds: number;
activityRatio: number | null;
topApps: AppUsage[];                    // top 3, replacing topApp: string | null
screenshots: TimelineScreenshot[];      // replacing screenshotId: number | null

// and a sibling type:
interface TimelineMarker {
  at: string;
  kind: "clock-in" | "clock-out" | "break-start" | "break-end"
      | "idle-start" | "active-again" | "screenshot";
  label: string;
}
```

Spans render as the ribbon; markers render as the rail. That is what makes the four
declared kinds reachable instead of dead, and it is the minimum shape that satisfies
§2.7 as written.

---

## 7. Gaps and timezone

**Gaps are deleted, and the component's own docstring says they matter.**
`activity-timeline.tsx:125` filters out every bucket where
`activeSeconds === 0 && idleSeconds === 0`, so a 90-minute offline gap renders as two
adjacent rows with no visual break — directly contradicting `:36-38`. Scope §2.6 also
specifies **three** statuses — Active, Idle, Offline — and the tone map at `:26-31` has
no offline tone at all.

**R10 — REJECT our current behaviour.** Drop the filter. An empty slot renders as an
explicit hatched ribbon segment, and a run of them produces one rail row: "No data ·
11:20 – 12:50". Do it as part of R5, not separately.

**Timezone is the viewer's, not the subject's.**
`apps/admin-dashboard/src/lib/format.ts:32 timeOfDay()` calls `toLocaleTimeString([])`
with no `timeZone`, and `apps/admin-dashboard/src/store/filters.ts:33 resolveRange()`
builds day boundaries from the *browser's* local midnight. There is no `timezone` column
on `profiles` or `devices`. A manager in IST reviewing an employee in PST gets a day
sliced at the wrong midnight and clock labels matching nobody's working hours. Cattr
passes `timezone` as an explicit prop from company settings and never trusts the
viewer's clock.

**R9 — ADAPT Cattr.** New migration adding `timezone text not null default 'UTC'` to
`public.profiles`; `timeOfDay(iso, timeZone?)` passes it through; `resolveRange(preset,
timeZone)` computes boundaries in the subject's zone; the timeline header states it
plainly ("times shown in Asia/Kolkata"). **Re-run `supabase/tests/rls_isolation.sql`
afterwards** — CLAUDE.md open item #2 makes that mandatory for any new column on
`profiles`, and it has already caught one privilege-escalation hole. Audit `longDate`
and `greeting` (`format.ts:36,43`) for the same latent assumption while there.

---

## 8. What we already have that is right

Worth recording so a rewrite does not lose it.

- **The interval algebra is correct and tested**, and it is better than either
  reference's. `packages/analytics/src/intervals.ts:27 merge()` collapses overlaps
  before summing — the docstring even names the two-device double-count case;
  `:62 difference()` subtracts idle from activity so idle is never counted as active;
  `:14 clamp()` trims to a window. `productivity.ts:44` composes them. Kimai's
  aggregation is per-timesheet-entry, which are non-overlapping by construction, so they
  never had to solve this; Cattr does not solve it at all. Tests at
  `packages/analytics/src/productivity.test.ts:90,199`.
- **The component's thesis is right.** A single continuous rail, not stacked cards.
  Screenshots attached to their event, not in a gallery. Four event kinds with icon and
  tone maps onto the design tokens. It just has no data and no page.
- **Design tokens are done.** `globals.css:13-98` — navy primary, indigo reserved for
  AI, emerald success, amber warning, 8px radius, `.tabular` numerics, a
  `prefers-reduced-motion` block. Inter via `next/font`.
- **Schema is ready for more than we use.** `work_sessions`, `break_events`,
  `idle_events`, `activity_events` with `window_title`/`url`/`domain`/`category`/
  `work_session_id`, and `screenshots.thumbnail_path` all exist, with indexes matching
  this access pattern.

---

## Explicitly not recommended

Named so they are not smuggled in later.

- **Cattr's month calendar heatmap** (`TimelineCalendarGraph.vue` — a 7-column ISO-week
  grid over a flat date→duration map). **PHASE 2.** Scope §2.7 and §4.4 describe a
  *day*; a month navigator is real work for a demo that shows one day.
- **Cross-employee swimlanes / a team-wide timeline canvas.** **PHASE 2.** §5 covers
  comparison via *reports*, not a shared timeline surface.
- **Editing events from the timeline** (ActivityWatch's event editor, Cattr's interval
  editor and "Add time"). **REJECT.** Out of scope, and it fights non-negotiable #5 —
  the audit log is append-only, and manager-editable activity data undermines the
  evidentiary value of the whole product.
- **Any use of `--accent` indigo in the timeline.** **REJECT** — reserved for AI
  surfaces.
- **Switching ingestion to heartbeats + `pulsetime`.** Closed in
  `activity-engine.md` §2. `floodGaps` gets the visual benefit at query time without
  touching the tested ingestion path.

---

## Summary of verdicts

| # | Finding | Verdict | Touches |
| --- | --- | --- | --- |
| R1 | Employee detail page + `/activity` page (the timeline has no home) | **ADAPT** | `app/people/[profileId]/`, `app/activity/` — shared with `dashboard-ia.md` |
| R2 | Server-side reduction: flood, mergeAdjacent, clusterShort, dayGrid | **ADOPT** principle, **ADAPT** rules | `packages/analytics/src/timeline.ts` (new) |
| R3 | `TimelineMarker` + widened `TimelineEntry` | **ADAPT** | `packages/types/src/dto.ts` |
| R4 | Route: order + limit + columns + sessions + breaks + signed URLs + fixed bucket set | **ADOPT** | `routes/analytics.ts:77-107`, `sdk/client.ts` |
| R5 | Two-layer SVG ribbon + rail; reject vis-timeline and Fabric | **ADAPT** rendering, **REJECT** libraries | `activity-timeline.tsx` |
| R6 | Two orthogonal colour channels; reject red bands | **ADAPT** idea, **REJECT** palette | `activity-timeline.tsx`, `globals.css` |
| R7 | Zoom, pan, shareable window | **ADAPT** contract, no library | `activity-timeline.tsx` |
| R8 | Screenshot strip bound to the same 600s grid | **ADOPT** | `screenshot-strip.tsx` — see `screenshots.md` R4 |
| R9 | Subject timezone on `profiles` | **ADAPT** | migration, `format.ts`, `store/filters.ts` |
| R10 | Gaps are data, not noise | **REJECT** current behaviour | `activity-timeline.tsx:125` |
