# Screenshots

> Capture, upload, storage layout, interval grouping, thumbnails, multi-monitor,
> blur, retention, deletion, and the review UI.
> Serves `docs/scope.md` §2.3 and §4.4.

Read source: Cattr `server-application`, `desktop-application` and
`frontend-application` at `main`. **ActivityWatch has no screenshot feature** and
contributed nothing to this area. Hubstaff and Apploye are vendor documentation only
and are marked as such.

Cattr is SSPL and cannot be borrowed from at source level. Everything below describes
an approach in prose.

---

## 1. A screenshot is not an entity — it is an attribute of an interval

**VERIFIED — Cattr `app/Models/TimeInterval.php`, `app/Contracts/ScreenshotService.php`.**

There is no screenshots table. `time_intervals` carries a `screenshot_id`, and the
model exposes a derived `has_screenshot` accessor that asks storage whether the file
exists. The service contract is two methods — `getScreenshotPath(interval)` and
`getThumbPath(interval)` — so **the object key is a pure function of the interval id**
and never has to be stored, indexed or signed.

The consequence is structural, and it is the most valuable idea in this document: *it
is impossible to render a bare gallery*, because a screenshot has no existence apart
from the interval that produced it. `docs/design.md` says "Not a plain gallery. Pair
each screenshot with the activity it belongs to" — Cattr enforces that in the data
model rather than in the UI.

Their own standalone `Screenshots.vue` module is the counter-example and the
anti-pattern: a flat three-column grid, fifteen per page, calendar/user/project
filters, no grouping by day or hour or interval, no bulk actions. That is precisely
what `docs/design.md` forbids, and it is in the same codebase as the good idea.

### Verdict

**ADAPT.** Keep screenshots as their own table — our schema is right, and a derived
path would break the moment retention or blur needs a second object. Take the
*grouping property* instead: bind every screenshot to a fixed interval slot at read
time, so the API cannot return a screenshot without the activity it belongs to. See §3.

---

## 2. Thumbnails are a first-class, cheap artefact

**VERIFIED — Cattr `ScreenshotService`, `app/Jobs/GenerateScreenshotThumbnail.php`.**
Named constants: format `jpg`, parent folder `screenshots/`, thumbs folder `thumbs/`,
**thumb width 280px**, **quality 50**. The upload is re-encoded to JPEG q50 and stored;
a queued job — `ShouldQueue` + `ShouldBeUnique` with `uniqueFor = 3600`, so a retry
storm cannot regenerate the same thumbnail twice in an hour — resizes to 280px wide
preserving aspect and writes to the thumbs subfolder. The original is retained.
Deletion removes both. Their review UI never loads a full-resolution image until the
user clicks.

### What we do today

`thumbnail_path` is declared at `supabase/migrations/20260805000001_init_schema.sql:233`
and **nothing writes it and nothing reads it** — a repo-wide grep finds it only in that
migration line and in the generated `packages/types/src/database.types.ts`. Any review
UI built today loads full-resolution 1920px q60 JPEGs.

### Recommendation — R2

**ADOPT Cattr's constants. ADAPT the generation site.**

280px at q50 transfers directly. Reject their queued-job machinery — we have no queue
by policy (CLAUDE.md forbids one) and Supabase Edge Functions have no image library
worth the dependency.

Generate in the agent, from the `NativeImage` we already hold:

```
// apps/desktop-agent/src/main/screenshot.ts, in ElectronCapturer.capture()
full  := source.thumbnail.toJPEG(60)                                  // exists today, :242
thumb := source.thumbnail.resize({ width: 280 }).toJPEG(50)           // new
```

This does **not** violate the comment at `screenshot.ts:36` about avoiding an image
library — `nativeImage` already does resize and JPEG encode natively, so no dependency
is added. The agent pays roughly 8 KB extra per frame on upload.

Wire changes: `screenshotFormData` (`:138`) appends a second file part named `thumb`;
`apps/api/src/routes/screenshots.ts` switches from `request.file()` (`:43`) to
`request.parts()`; the thumb is written to
`screenshotPath(companyId, profileId, "thumbs/" + filename)` and `thumbnail_path` is
set in the upsert. **On thumb failure, still store the original and leave
`thumbnail_path` null** — the full image is the record of fact, the thumbnail is an
optimisation. Have `supabase/functions/screenshot-worker/index.ts` report a count of
rows with a null `thumbnail_path` so a regression is visible.

Sized: a 48-tile review page goes from roughly 10 MB of full-resolution JPEGs to
roughly 400 KB. That is the difference between a screenshots tab and a screenshots tab
that a manager will open twice.

---

## 3. Interval grouping — one time unit shared by three views

**DOCUMENTED — Apploye.** Screenshots are grouped into fixed blocks with a header
carrying the time range and project name. Each block carries an activity percentage
described as "the precise activity ratio for each 10-minute interval", colour-banded
red 0–30 / yellow 30–60 / green 60–100, and a monitor icon indicating the **number of
monitors captured** for that block. The Apps and URLs tabs present the same interval
with per-app and per-domain durations under the same filters.

**DOCUMENTED — Hubstaff.** Frequency is expressed as "N screenshots per 10-minute
period" (1× free, up to 3× paid) rather than "every N minutes" — the block is the unit,
the count is the setting.

**INFERRED, and this is the point:** the reason their three views line up is that
there is one grid, not three. The screenshot, the activity percentage and the app list
all hang off the same 10-minute cell. Ours currently share no unit at all.

### What we do today

`packages/analytics/src/productivity.ts:115` uses `.find(...)` — **at most one
screenshot survives per slot** — and `bucketSeconds` defaults to 3600
(`apps/api/src/routes/analytics.ts:12`) while the capture interval defaults to 300
(`screenshot.ts:52`). Seed twelve screenshots across one hour, call
`/api/analytics/timeline` at the default bucket: one entry, one `screenshotId`, eleven
captures invisible. Scope §2.3 offers a 1-minute interval, at which the endpoint
discards 59 of every 60 captures.

Worse, `TimelineEntry.screenshotId` (`packages/types/src/dto.ts:158`) is a bare
`number | null` and `analytics.ts:109-118` returns it unresolved — no `createSignedUrls`
call, unlike `routes/screenshots.ts:158` which already does exactly that. There is no
path and no URL in the response, so the dashboard could not render an image even for
the one screenshot it does get.

### Recommendation — R3

**ADOPT the fixed-block unit.**

- `productivity.ts:115` — replace `.find` with a filter, collecting
  `{ id, capturedAt, storagePath, thumbnailPath, captureGroupId, displayIndex, displayCount }[]`
  sorted by `capturedAt`. Change `TimelineEntry.screenshotId` to
  `screenshots: TimelineScreenshot[]` in `packages/types`, and fold in `screenshotCount`
  and `monitorCount = max(displayCount)` for the block header badge.
- `apps/api/src/routes/analytics.ts:109-118` — after `buildTimeline`, gather every
  `thumbnailPath` (falling back to `storagePath`) across all entries and resolve them
  in **one** `createSignedUrls(paths, 600)` call, the exact pattern already working at
  `routes/screenshots.ts:158-165`. One batch call per request, never one per bucket.
- `timelineSchema` (`analytics.ts:11`) — default stays 3600 for the day strip, but the
  review view requests 600. Add `bucketSeconds` as a parameter on `getTimeline` in
  `packages/sdk/src/client.ts:166`, which today cannot request any granularity but the
  default.

---

## 4. Multi-monitor

**VERIFIED — Cattr `desktop-application`.** They enumerate screen sources, open each as
a MediaStream, pull a frame via the ImageCapture API, and **paint them side by side
onto a single canvas** whose width is the sum of display widths and whose height is the
max display height, tracking a running x-offset. Output is one JPEG at quality 0.5. The
main process strips the data-URI prefix and buffers the bytes.

### What we do today — better, then thrown away

`apps/desktop-agent/src/main/screenshot.ts:221` makes **one**
`desktopCapturer.getSources` call for all monitors, then per display calls
`matchSourceToDisplay` (`:122`), which requires exact string equality of
`source.display_id` and treats an empty string as a match *failure* rather than falling
back to positional order. `captureSize` (`:94`) reduces to the maximum **physical**
pixel size across displays and downscales to `MAX_CAPTURE_WIDTH = 1920` preserving
aspect — asking the compositor for the smaller frame rather than encoding 4K and
resizing after. Output is one `CapturedScreenshot` per display, all sharing one
`capturedAt` but each getting its own `randomUUID()` `clientEventId` (`:206-211`).

Then the identity is dropped on the wire. `screenshot.ts:11` documents `displayId` as
existing "so the timeline can label multi-monitor captures", but `screenshotFormData`
(`:138-157`) never appends it, `metadataSchema` in `routes/screenshots.ts:9-14` has no
field for it, and `public.screenshots` has no column. It survives only into the
dead-letter record (`sync.ts:115`). Upload two frames from a two-monitor machine and
nothing in the database distinguishes the rows but `client_event_id` — and nothing
groups them either, so a single capture moment renders as two unrelated tiles with
identical timestamps.

### Recommendation — R1

**ADAPT Cattr's idea; REJECT their mechanism.**

Reject the composite: a 3840×1080 stitched JPEG is illegible at review size, doubles
the bytes of every moment even when only one display mattered, and makes "which
monitor" unanswerable forever. Adopt instead the property their model gets for free —
**a capture moment is one addressable unit**.

New migration `supabase/migrations/20260805000007_screenshot_capture_group.sql`:

```sql
alter table public.screenshots
  add column capture_group_id uuid not null default gen_random_uuid(),
  add column display_id       text,
  add column display_index    smallint not null default 0,
  add column display_count    smallint not null default 1,
  add column linkage_attempted_at timestamptz;   -- used by R5

create index on public.screenshots (company_id, profile_id, capture_group_id);
-- backfill capture_group_id from existing (device_id, captured_at) pairs
```

RLS needs no change — the existing two SELECT policies still cover the table.

Agent: mint **one** `captureGroupId` per `tick()` beside `capturedAt` (`:203`) and map
`displayIndex` / `displayCount` from the frames array. Keep the per-frame
`clientEventId` — it is what makes the retry idempotent against the unique
`(device_id, client_event_id)` index.

`screenshotFormData` (`:138`) must append the four fields **before** the file part. The
ordering rule documented at `:133-137` is real — the route reads `file.fields` before
draining the stream — and a field appended after the file is silently invisible. Write
a test asserting the order.

---

## 5. Policy: screenshot capture is a four-state enum with inheritance

**VERIFIED — Cattr `app/Enums/ScreenshotsState.php`.** Four values: `ANY = -1`,
`FORBIDDEN = 0`, `REQUIRED = 1`, `OPTIONAL = 2`, with `mustBeInherited()` returning
true for FORBIDDEN and REQUIRED — a project or a user cannot loosen a company-level ban
or opt out of a company-level requirement. Settable at company, project and user level.
Critically, **both** the interval-create endpoint and the attach-screenshot endpoint
re-evaluate the effective state server-side. The agent's opinion about its own policy
is not trusted.

### What we do today

Capture is suppressed only by consent (`mayCollect`), session lock, and a declared
break (`collector.ts:242`). There is no company- or employee-level screenshot on/off,
so a role or a person for whom screen capture is inappropriate cannot be exempted
without revoking their consent entirely. Scope §4.2's "enable/disable monitoring" has
no screenshot-level expression.

### Recommendation — R6

**ADAPT.** Their `ANY = -1` is a query filter, not a policy; we need three values. The
inheritance rule is the part worth taking.

```sql
alter table public.policies add column screenshot_capture text not null default 'required'
  check (screenshot_capture in ('forbidden','required','optional'));
alter table public.profiles add column screenshot_capture_override text
  check (screenshot_capture_override in ('forbidden','required','optional'));
-- effective = company value, unless company value is 'optional', in which case override applies
```

Because `policies` is versioned and consent is recorded against a version, changing
this correctly forces a new policy version and fresh consent. That is the right
compliance behaviour, not an inconvenience.

Enforce in `apps/api/src/routes/screenshots.ts` immediately after the consent check
(`:36-41`): return 403 `screenshots_not_permitted` when the effective state is
forbidden. This is the enforcement point per non-negotiable #1. Also read the field in
`screenshot.ts:194` and return `[]` from `tick()` when forbidden, so the agent does not
waste a capture it cannot upload — belt and braces, with the server as the belt. Write
the effective-value resolution **once**, as a shared helper used identically by both
gates.

Surface it in the dashboard employee settings as the concrete meaning of scope §4.2.

---

## 6. The review UI

**VERIFIED — Cattr `frontend-application`.** Their good surface is `Timeline.vue`, a
master-detail: a day graph whose segment click emits selected intervals, with a
screenshot panel below rendering the same user's intervals for the same range. One
selection drives both panels.

`Screenshot.vue` loads a **thumbnail** through a configurable path provider,
`lazyImage` defaults to true, shows a 100px skeleton placeholder while loading, and
renders task, project and start time in the viewer's timezone alongside an activity bar
(their `activity_fill` is a 0–200 sum of two 0–100 channels, rendered as `fill / 2`
percent, with a tooltip breaking it into mouse and keyboard).

`ScreenshotModal.vue` loads the full-resolution image at `object-fit: contain`,
`max-height: 70vh`, with a two-column footer — project, task, user, created-at on the
left; overall activity %, mouse %, keyboard %, duration on the right — and prev/next
buttons. A trash button renders only when a `canRemove` prop is set, and there is no
confirmation dialog. **No keyboard navigation.**

`TimelineScreenshots.vue` adds multi-select with **shift-click range selection** (an
anchor index defines the range) feeding a selection array into bulk edit and bulk
delete.

### What we do today

There is no screenshots surface at all. `apps/admin-dashboard/src/app` contains exactly
`page.tsx`, `people/page.tsx`, `devices/page.tsx`. `packages/sdk/src/client.ts` has
`uploadScreenshot` (`:149`) and `getTimeline` (`:166`) but no screenshot list method.
The one screenshot-aware component,
`apps/admin-dashboard/src/components/activity-timeline.tsx:106-113`, renders
`event.screenshotUrl` — but `bucketsToEvents` (`:123-135`) emits only `"app"` and
`"idle"` kinds and never sets `screenshotUrl`, and grep confirms **no page imports
either function**. Scope §4.4 requires a Screenshots section on the employee detail
page; it is 0% implemented.

### Recommendation — R4

**ADAPT Cattr's modal and lazy tile. ADOPT Apploye's block header. REJECT their
standalone gallery.**

New `apps/admin-dashboard/src/components/screenshot-review.tsx`, driven by the R3
`TimelineEntry[]`:

- **One row per 10-minute block.** Left rail: block time range, `topApp`, and the
  active/idle split — **never a bare percentage.** Render "Active 7m 30s · Idle 2m 30s"
  with a thin bar. `docs/design.md:173-181` is explicit that a bare percentage reads as
  a score.
- Right: the block's thumbnails in a horizontal strip, each `loading="lazy"` with a
  skeleton placeholder, and a Lucide `Monitor` badge with the count when
  `monitorCount > 1`.
- **Blocks with no capture render an explicit "No capture" cell** rather than
  collapsing, so a gap is legible as a gap.
- Lightbox: a `packages/ui` Dialog loading the full-resolution signed URL at
  `object-fit: contain`, footer split two ways after Cattr's modal — employee, device,
  capture time, work session on the left; top app, website, active/idle split on the
  right — with prev/next stepping across blocks. **Add keyboard arrows and Escape.**
  Cattr has none; Linear-grade keyboard behaviour is a `docs/design.md` expectation.
- Shift-click range multi-select is worth building even before any bulk action exists,
  because it is the affordance a future export or delete hangs off. Wire it only to
  "Export selected" until R7(d) lands.

Route: `apps/admin-dashboard/src/app/people/[profileId]/page.tsx` with the seven tabs
scope §4.4 names, rendering the currently-unused `ActivityTimeline` on the Timeline tab.
See `dashboard-ia.md` §2 — this page is shared with that area and should be built once.

`packages/sdk/src/client.ts` gains `listScreenshots(profileId, from, to, limit)` hitting
the existing `GET /api/screenshots`. Wire through TanStack Query; only the date and
employee filters go in Zustand.

Also fix `bucketsToEvents` (`activity-timeline.tsx:123`) to emit a `"screenshot"` kind
carrying the first thumbnail URL of each bucket, which finally makes the
`screenshotUrl` branch at `:106` live.

---

## 7. Retention

**VERIFIED — Cattr `app/Helpers/StorageCleaner.php`, `RotateScreenshots.php`,
`app/Console/Kernel.php`.** Retention is **disk-pressure-driven "thinning"**, not an
age cutoff. A `needThinning()` check computes used/total percentage against a
configured threshold; `thin()` then deletes screenshots in pages, under a cache lock to
prevent concurrent runs, until used space falls below a waterline. It is scheduled
weekly and gated on a company-level `auto_thinning` setting, alongside a daily
attachment-verification command that runs `withoutOverlapping()` and iterates with a
lazy cursor rather than loading everything.

What is genuinely interesting is the **order of sacrifice**: intervals on non-important
tasks first, then non-important projects, then users without permanent retention, then
oldest by id.

### What we do today

**No retention mechanism of any kind exists.** `public.policies` carries
`screenshot_interval_seconds` and `idle_threshold_seconds` and nothing about screenshot
lifetime. No Edge Function deletes anything. The storage bucket has a per-file 10 MiB
cap and no aggregate bound.

Sized, so this is a scheduled decision rather than a surprise: at q60/1920 a 1080p
frame is roughly 150–250 KB. Twelve per hour × 8 hours × 2 monitors ≈ 192 frames/day ≈
30–48 MB/day ≈ **0.7–1.0 GB per employee per month, growing without bound.**

### Verdict

**PHASE 2, and REJECT their mechanism outright.** Cattr's disk-pressure model does not
transfer: Supabase Storage bills per GB and has no disk that fills, so `needThinning()`
has no premise. The transferable idea is the *priority order*. If retention is wanted,
it should be age-based per company (`policies.screenshot_retention_days`), executed from
the existing screenshot worker deleting the object, then the thumbnail, then the row,
in batches, writing an audit entry. Not in `docs/scope.md`. Flag the number now.

---

## 8. Deletion, flagging, and blur

**DOCUMENTED — Hubstaff deletion.** Deletion splits by role into two *different*
operations: owners, managers and project managers remove the screenshot and **keep** the
associated time; the tracked user removes the whole activity block — screenshot **and**
its time. Deletion is permanent. The delete affordance itself is an org setting. The UI
supports hover-to-delete on a tile, checkbox multi-select with a trash icon, whole-row
deletion, and select-all, each behind a confirmation.

**DOCUMENTED — Apploye deletion.** Employee-initiated deletion requires a reason to the
owner and forfeits the time frame associated with the screenshot; the owner can toggle
employee deletion off entirely.

**DOCUMENTED — Hubstaff blur.** Configured org-wide **and** per individual user, applied
**on the device before upload** so the server never holds an unblurred copy,
irreversible once applied. Their documentation explicitly claims a blurred shot still
lets a reviewer "gauge activity levels" — i.e. it is calibrated to preserve layout while
destroying text. Paid-plan feature.

### What we do today

There is no delete or flag path for any role. There is no `DELETE /api/screenshots/:id`,
and RLS on `public.screenshots` (`20260805000002_rls_policies.sql:254-263`) declares
**only two SELECT policies** — not even a super admin can remove a screenshot through
Supabase. This is safe-by-default, but it means an accidentally captured password
manager or medical record has no removal route short of a manual SQL session.

Blur is plumbed end to end and nothing can ever set it: the field exists in
`packages/types/src/dto.ts:113`, `screenshot.ts:153`, `routes/screenshots.ts:99` and the
column, and there is no blur transform anywhere in the agent and no policy field that
could request one. It is `false` on every row ever written.

### Verdict

Both **PHASE 2**, stated plainly.

**Deletion and flagging** are not in `docs/scope.md`. Deliberately *not* justified under
§8 "advanced compliance" — that is a Later item and off-limits. The honest argument for
it is incident response, and it is the client's call. If it is taken: one route, a
delete RLS policy, an append-only audit entry (non-negotiable #5), and Hubstaff's role
split.

**Blur** is not in scope either, and is not on the §8 Later list — so it is Phase 2 by
the scope document's default rule, not a forbidden item. The blocker is technical:
`nativeImage` has no blur, so this needs either `sharp` (a native dependency the agent
has deliberately avoided — see `screenshot.ts:36`) or a canvas filter in a hidden
`BrowserWindow`, which is a second capture surface to secure. The `blurred` column and
DTO field already exist, so the wire contract is ready when the decision comes.

**Randomised capture time within the interval** is a third Phase 2 item worth naming.
Both Apploye and Hubstaff randomise the offset inside the block. Our `isCaptureDue`
(`screenshot.ts:60`) fires on the first collector tick where elapsed ≥ interval, so
under a five-minute policy every capture lands within one tick of :00, :05, :10 for the
life of the process — perfectly predictable, and therefore avoidable. The
implementation would be small: keep the interval as a *window* and draw a per-window
offset from a seeded PRNG so it stays reproducible in tests. But scope §2.3 says
"configurable interval", not "randomised within interval". It is the cheapest
credibility win in this document and it is still a scope change.

---

## 9. What we already do well, and one durability hole

Worth recording so it is not regressed.

- `isCaptureDue` (`screenshot.ts:60`) is pure and clock-free. A non-finite or
  non-positive interval returns false — **failing toward fewer captures, never a
  flood**. A negative elapsed gap (sleep, resume, NTP correction) returns true so the
  schedule re-bases instead of stalling.
- The interval is consumed **before** the capture attempt (`:199`), so a permanently
  failing capturer is not retried on every collector tick.
- `sessionLocked` gates capture (`:192`) because Windows returns black frames on a
  locked or RDP-disconnected session.
- `collector.ts:242` skips capture entirely while on a declared break. **Declared break
  time is never photographed.** That is a compliance property, not a convenience.
- Upload is sequential (`sync.ts:416`), deliberately not parallel, so it does not
  compete with the employee's own uplink. A `dropped` classification (415/413/400)
  quarantines an allowlisted record — `clientEventId`, `capturedAt`, `displayId`,
  `workSessionId`, `blurred` — and the JPEG is explicitly kept out of the plaintext
  dead-letter file.
- The upload route writes the binary to Storage **first**, then upserts metadata with
  `ignoreDuplicates`, removes the object on metadata failure, and on a duplicate removes
  the just-written object and returns `{ duplicate: true }`. A replay costs bandwidth
  but never a second row.

The hole: `sync.ts:294-296` deliberately does **not** journal screenshots —
"they stay in memory and a crash still loses them. Documented, not forgotten." With
`DEFAULT_MAX_BUFFERED_SCREENSHOTS = 60` (`:177`) and oldest-first eviction, a
five-minute cadence on two monitors is 24 frames/hour, so an offline laptop begins
silently discarding captures after about **150 minutes** and loses everything buffered
on a power failure. Not recommended for change in this pass — journalling binary blobs
is a different durability design from journalling NDJSON events — but the ceiling
should be a conscious number, not a default.

---

## 10. The workers are broken in two specific, testable ways

**The orphan sweep can never match anything.**
`supabase/functions/screenshot-worker/index.ts:53` calls
`storage.from("aems").list("", { limit: 1000 })`, which returns only the bucket's
immediate children — company-id folder entries whose `name` contains no slash — so the
`object.name.includes("/screenshots/")` filter at `:57` is always false. Even with
recursion it would still fail, because `list` returns names relative to the listed
prefix while `storage_path` holds the full four-segment key, so the
`.eq("storage_path", object.name)` lookup at `:61` would also miss. Upload a screenshot,
delete its row, invoke the worker: `orphansRemoved: 0`.

**The linkage pass starves itself and is O(n) queries.** `:20-50` selects
`work_session_id is null limit 500` with no `company_id` filter, no `captured_at` floor
and no ordering, then runs one `work_sessions` query **per screenshot**. Rows that can
never be linked — captured outside any session — are re-selected on every run forever
and permanently occupy the 500-row window. Insert 500 unlinkable screenshots and then
one linkable one: the linkable row is never reached.

### Recommendation — R5

**ADAPT Cattr's `VerifyAttachments` shape — bounded, background, non-overlapping,
cursor-driven. REJECT the current implementation; this is a rewrite, not a tune.**

Orphan sweep: an explicit two-level walk — `list(companyId)`, then
`list(companyId/profileId/screenshots)` — reconstructing the full four-segment key
before the lookup. Only consider objects older than one hour, so an in-flight upload
between the storage write (`routes/screenshots.ts:79`) and the row insert (`:89`) is
never swept. Persist a cursor in a small `worker_state` table added in the R1 migration
so each run is bounded and the whole bucket is covered over time.

Linkage pass: add a `company_id` filter, a `captured_at >= now() - interval '7 days'`
floor, an ordering, and set the new `linkage_attempted_at` on every row examined so
unlinkable rows fall out of the working set. Replace the per-row session query with one
`work_sessions` fetch per device per run and an in-memory interval match — 500
sequential round trips is the current cost and it is why this function will time out
first.

---

## Summary of verdicts

| # | Finding | Verdict | Touches |
| --- | --- | --- | --- |
| R1 | Capture group + display identity on the wire | **ADAPT** (idea from Cattr, reject their composite) | `screenshot.ts`, `routes/screenshots.ts`, migration `…0007`, `dto.ts` |
| R2 | Thumbnails, 280px q50, generated in the agent | **ADOPT** constants, **ADAPT** site | `screenshot.ts`, `routes/screenshots.ts`, `screenshot-worker` |
| R3 | All screenshots per block, with batch-signed URLs | **ADOPT** | `productivity.ts:115`, `routes/analytics.ts`, `dto.ts`, `sdk/client.ts` |
| R4 | Interval-grouped review UI + lightbox | **ADAPT** Cattr modal, **ADOPT** Apploye block, **REJECT** their gallery | `people/[profileId]/`, `screenshot-review.tsx`, `activity-timeline.tsx` |
| R5 | Worker: orphan sweep + linkage rewrite | **ADAPT** shape, **REJECT** current impl | `screenshot-worker/index.ts` |
| R6 | Screenshot capture as an enforced policy dimension | **ADAPT** | migration, `routes/screenshots.ts`, `screenshot.ts:194`, dashboard settings |
| R7a | Randomised capture offset within the interval | **PHASE 2** | — |
| R7b | Device-side blur | **PHASE 2** | — |
| R7c | Retention / thinning | **PHASE 2**, **REJECT** disk-pressure model | — |
| R7d | Deletion and flagging, role-split | **PHASE 2** | — |
