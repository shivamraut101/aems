# Activity engine

> Window and app capture, URL/domain extraction, the heartbeat-vs-interval question,
> idle detection, activity-level percentage, and categorisation.
> Serves `docs/scope.md` §2.2, §2.4, §2.5, §2.6.

Read source: ActivityWatch (`aw-core`, `aw-server`, `aw-client`, `aw-watcher-window`,
`aw-watcher-afk`, `aw-webui`, `aw-server-rust`) at `master`; Cattr
(`desktop-application`, `server-application`) at `main`. Vendor documentation:
Hubstaff, Apploye, ActivTrak.

---

## 1. The event model

**VERIFIED — `aw-core/aw_core/models.py`.** ActivityWatch's event is four fields:

| Field | Shape | Notes |
| --- | --- | --- |
| `id` | int or str, optional | Assigned by the datastore. `None` on the wire. |
| `timestamp` | ISO8601, normalised to UTC | Microseconds truncated to **milliseconds** at construction. A naive timestamp gets UTC attached. |
| `duration` | seconds (float on the wire, `timedelta` internally) | A bare number is coerced; anything else raises. |
| `data` | free-form JSON object | Schema is by bucket *type*, never enforced. |

**There is no `end` field anywhere.** End is always derived as `timestamp + duration`,
and the merge path *mutates duration in place* rather than recomputing from an end
timestamp. Equality compares timestamp + duration + data and deliberately **ignores
`id`**.

Storage (**VERIFIED — `aw_datastore/storages/sqlite.py`**) is where it gets
interesting: `starttime` and `endtime` are stored as **integer microseconds since
epoch**, not text and not floats, with indexes on `(bucketrow, starttime)` and
`(bucketrow, endtime)`. Reads use overlap semantics ordered by endtime descending:

```
WHERE bucketrow = ? AND endtime >= ? AND starttime <= ? ORDER BY endtime DESC LIMIT ?
```

So `get(limit=1)` returns the latest-*ending* event, not the latest-starting one.
That choice is load-bearing for their AFK state machine (§4).

A *bucket* is their unit of stream identity: `bucket_id` (PK), `type` (the event-type
discriminator — `"currentwindow"`, `"afkstatus"`), `client` (watcher name),
`hostname`, `created`, `name`, `data`. Convention is
`bucket_id = f"{client_name}_{client_hostname}"`, verified identical in both watchers.
Our `device_id` plus a per-table split is the same idea by another name — but note
what they get from it that we do not: **one timeline row per bucket**, which is how a
person with a laptop and a phone reads correctly in their UI.

### Verdict

**ADAPT — nothing to change now.** Our schema already carries closed intervals with
explicit `started_at`/`ended_at` and a `client_event_id` idempotency key, which is
strictly more information than their `timestamp + duration`. The one idea worth
holding onto is **stream identity as a first-class thing** — see `timeline.md` §7 on
`deviceId` being a fiction when a person has two devices. Touches nothing today.

---

## 2. Heartbeats vs closed intervals — closing the open question

`docs/inspiration.md` §"Research findings" left this open. It should now be closed.

**VERIFIED — `aw-core/aw_transform/heartbeats.py`.** Their merge is:

1. "Same data" is **exact dict equality on the whole `data` object**. One changed key —
   a window title — ends the event. Not a subset check, not key-selective.
2. The admission window is measured from the **end** of the last event:
   `pulseperiod_end = last.timestamp + last.duration + pulsetime`.
3. Admission test is `last.timestamp <= heartbeat.timestamp <= pulseperiod_end`. A
   heartbeat *before* the last event's start is refused.
4. `new_duration = (heartbeat.timestamp - last.timestamp) + heartbeat.duration`, then
   `last.duration = max(last.duration, new_duration)`. The timestamp never moves.
5. Any failure returns nothing and the caller inserts a new event.

The `max` in step 4 is the anti-double-count device, and it is also why **replay is
idempotent by construction**: re-sending the same heartbeat recomputes the same
`new_duration` and the `max` is a no-op. That is the whole reason AW needs no
client-side event id.

Two defects worth naming precisely, because they are the argument against adopting
this:

- **The negative-duration guard tests the wrong variable.** It checks whether
  `last_event.duration` is already negative, not whether `new_duration` is — so it
  cannot fire on the case its own log message describes.
- **Server-side application is an UPDATE per heartbeat.** `ServerAPI.heartbeat` keeps
  an in-process per-bucket cache of the last event and calls `replace_last(merged)`.
  The SQL targets the row with `max(endtime)`, not a row id, and the source carries a
  `FIXME` conceding this "causes a already existing 'newer' event to be overwritten …
  This is problematic."

**VERIFIED — `aw-server-rust/aw-transform/src/heartbeat.rs`.** The Rust rewrite is
deliberately stricter and fixes both: it computes `starttime = min(...)`,
`endtime = max(...)`, `duration = endtime - starttime` — i.e. it takes the **span
union** rather than mutating a duration — refuses when the heartbeat precedes the last
event, and guards the *computed* duration. Their own test comment records the intended
client behaviour: *"note that no duration is sent, which is how aw-client works"* —
watchers send `duration=0`.

**VERIFIED — `aw-client/aw_client/client.py`.** The client runs the *same* merge
locally and only enqueues an HTTP request when accumulated duration reaches a
configured `commit_interval`. The queue is a disk-backed SQLite FIFO. Retry policy:
connect timeout and HTTP 500 keep the item queued and retry after 0.5s; **HTTP 400
drops the request** with "Bad request, not retrying".

So AW is a **three-stage** pipeline — poll → in-memory client merge → disk queue →
server merge — and the network rate is governed by `commit_interval`, not by poll time.

### What we do today

`apps/desktop-agent/src/main/tracker.ts:160-184` holds one open interval and emits an
`ActivityEventInput` only when focus changes. Identity is `appName + domain`;
`windowTitle` is deliberately excluded (`:150-158`) so an editor moving between files
is one stretch. `close()` (`:186-196`) mints the `clientEventId` at emit time, which is
the idempotency key the whole ingestion path rests on.
`apps/desktop-agent/src/main/collector.ts:21` caps any interval at five minutes via
`rollLongInterval()` (`:214-221`), closing and reopening at the same instant.

### Verdict

**REJECT — and record it so it stops being reopened.**

The crash-durability argument that motivated heartbeats has already been answered
differently: `apps/desktop-agent/src/main/persistence.ts:165` is an append-only NDJSON
`EventJournal` written **before** the network call, and `DayState` (`:351-363`)
persists the open focus interval, open idle start, open break start and last capture
time. The property heartbeats buy — "durable after the first poll" — we buy with a
journal, without moving idempotency off `client_event_id`, without one UPDATE per
poll against Supabase Postgres, and without invalidating the unique
`(device_id, client_event_id)` indexes in `20260805000001_init_schema.sql` and the
upserts at `apps/api/src/routes/activity.ts:166`.

Their gap-repair behaviour, which is the *visible* benefit, is available to us at
query time — see `flood` in §6 and the `bridgeGaps` recommendation in `timeline.md`.

---

## 3. Activity level — the industry metric

This is the single most important finding in this document, because scope §6's own
worked example (`Productivity: 86%`) cannot honestly be produced by anything in our
codebase today.

**VERIFIED — Cattr `server-application`.** Three nullable integers hang off
`time_intervals`: `activity_fill`, `mouse_fill`, `keyboard_fill`. Each is validated
`nullable|int|between:0,100`. There is no accessor — the number is computed **entirely
on the client**. A migration explicitly *dropped* an earlier design that stored raw
`count_mouse` / `count_keyboard` counters.

**VERIFIED — Cattr `desktop-application`, an Electron app like ours.** The counter
keeps three per-second boolean flags (keyboard active this second, mouse active this
second, system active this second) and three accumulators of active seconds. The
percentage is, quoted because the exact form matters:

> `Math.round(activeSeconds.keyboard / (intervalDuration / 100))`
> — Cattr, `app/src/utils/event-counter.js`

Guarded to return 0 when either operand is 0; **not clamped to 100**. One input
anywhere in a second marks the second — no distinction between a mouse move and a
click, no throttling, no measure of volume.

The decisive detail for us: their `systemActiveDuringThisSecond` is derived from
Electron's `powerMonitor.getSystemIdleTime()` returning 0. **That is the same API we
already inject** at `apps/desktop-agent/src/main/index.ts:458`. A per-second
system-activity signal costs us zero new native dependencies and zero keystroke
interception.

**DOCUMENTED — Hubstaff.** "Active seconds / 600 = activity rate % for each 10-minute
segment. A mouse movement or keyboard stroke = active." They show a keyboard/mouse
split on hover (e.g. 80% overall, 7% keyboard, 74% mouse) and state explicitly that
keystrokes themselves are not recorded. Their own worked example: 30 seconds of typing
then 9m30s watching a video scores 5%.

**DOCUMENTED — Apploye.** The same figure on a fixed 10-minute grid, colour-banded red
0–30 / yellow 30–60 / green 60–100, with the screenshot, the activity % and the app
list all hanging off that one interval.

**INFERRED, and the point of the section:** two independent implementations — one
source-readable, two documented — compute the same quantity the same way. The metric
is *seconds containing input*, not input volume. It is not a ratio of tracked time.
It is defensible to an employee precisely because it measures presence at the machine
rather than intensity of work.

### What we do today

`packages/analytics/src/productivity.ts:53` computes
`productivityRatio = activeSeconds / (activeSeconds + idleSeconds)` — a ratio of
*tracked* time. Feed `summarisePeriod` one eight-hour activity event and zero idle
events and it returns `1.0000`. An employee who read a document for eight hours
without crossing the 300-second idle threshold scores 100%. No field in
`packages/types/src/dto.ts`, in the schema, or in the agent holds a
seconds-containing-input figure.

### Recommendation — R1

**ADOPT the metric. ADAPT the segmentation and the presentation.**

New `apps/desktop-agent/src/main/activity-level.ts`, pure and clock-free in the shape
of `idle.ts`:

```
ACTIVITY_SAMPLE_INTERVAL_MS = 1_000
ACTIVITY_SEGMENT_SECONDS    = 600

class ActivityLevelCounter
  sample(idleSeconds, now) -> ActivitySegmentInput | null
    active   := idleSeconds === 0          // getSystemIdleTime floors to whole seconds
    segment  := floor(now / (600 * 1000))  // wall-clock aligned, NOT process-relative
    if segment != currentSegment: emit previous, reset
    sampledSeconds += 1
    activeSeconds  += active ? 1 : 0
```

Four deliberate divergences from Cattr:

1. **Wall-clock-aligned segments.** Cattr ties the segment to the screenshot interval,
   which makes two employees on different screenshot policies incomparable. Scope §5
   asks for employee comparison. Fixed, aligned 600s grid, always — and it is the same
   grid the screenshot strip and the app list use (see `timeline.md` §2, `screenshots.md` §3).
2. **Accumulate `sampledSeconds` alongside `activeSeconds`** — samples taken, not
   wall-clock elapsed. A missed timer must not read as inactivity. This is exactly
   where Cattr's unclamped division can exceed 100 and ours cannot.
3. **Send counts, never a percentage.** Derive the percentage server-side, so a
   segment truncated by clock-out or a crash reports honestly instead of reading 40%
   because it only ran four minutes.
4. **Suppress while on a declared break** (the precedence `idle.ts:110` already
   establishes) and while `mayCollect()` is false.

Wiring, layer by layer:

| Layer | Change |
| --- | --- |
| `apps/desktop-agent/src/main/collector.ts` | A **second** timer at 1 Hz alongside `start()` (`:121-126`). Do not drop `TICK_INTERVAL_MS` (`:18`, 5s) to 1s — on macOS each browser sample is an AppleScript round-trip (`browser-url.ts:101-104`). Two timers, one job each. |
| `apps/desktop-agent/src/main/persistence.ts` | Add `openSegment` to `DayState` (`:351-363`), beside `openIdleSince`. Without it every restart loses up to ten minutes of counters and the segment reads artificially low. |
| `packages/types/src/dto.ts` | `ActivitySegmentInput`; `ActivityBatch.segments?`; `ActivityBatchResult.acceptedSegments`; `activityPercent: number \| null` on `TimelineEntry` and `ProductivitySummary`. |
| `supabase/migrations/20260805000007_activity_segments.sql` | New table (below). |
| `apps/api/src/routes/activity.ts` | A `segmentSchema` in `batchSchema` (`:29-35`) and a fourth upsert block with `onConflict: "device_id,client_event_id", ignoreDuplicates: true`, exactly like the three at `:150-221`. |
| `packages/analytics/src/activity-level.ts` | New. |
| `apps/admin-dashboard/src/components/activity-timeline.tsx` | Per-segment bar on the rail. |

The table:

```sql
-- sketch, not final
activity_segments (
  id, company_id, profile_id, device_id, work_session_id,
  segment_start_at  timestamptz not null,
  segment_end_at    timestamptz not null,
  sampled_seconds   int not null check (sampled_seconds > 0),
  active_seconds    int not null check (active_seconds >= 0),
  check (active_seconds <= sampled_seconds),
  activity_percent  smallint generated always as
                      (round(100.0 * active_seconds / sampled_seconds)) stored,
  client_event_id   uuid not null,
  created_at
)
unique (device_id, client_event_id)
index  (company_id, profile_id, segment_start_at desc)
```

The generated column is the same trick `idle_events.duration_seconds` already uses —
it cannot drift from its inputs. RLS mirroring the `idle_events` policies in
`20260805000002_rls_policies.sql` is mandatory; a table without RLS is a bug per
CLAUDE.md, and open item #2 requires re-running `supabase/tests/rls_isolation.sql`.

`activityLevel(segments, window)` in the analytics package must be **time-weighted by
`sampledSeconds`, not a mean of percentages**. A full 600s segment at 80% beside a 30s
tail at 5% averages to 42.5% unweighted; the truth is 76.4%.

**Presentation: REJECT Apploye's red band.** Bands in our palette — emerald ≥60, amber
30–59, muted <30. No red. `docs/design.md`'s positioning rule and CLAUDE.md's copy
rule both forbid a punitive read, and a red block beside a person's name is exactly
the surveillance framing we are positioned against. Label it "Input activity", not
"Productivity".

**REJECT `iohook` / `uiohook-napi`.** A per-platform native prebuild — the exact
failure mode `tracker.ts:17-21` already warns about for `get-windows` — requiring
macOS Accessibility, and a global keystroke listener in a product whose first design
rule is "not surveillance" is a positioning failure before it is a build one. The cost
is one combined figure where Hubstaff shows keyboard and mouse separately. Label it
honestly rather than faking a split.

---

## 4. Idle / AFK

**VERIFIED — `aw-watcher-afk`.** Defaults: `timeout = 180`s, `poll_time = 5`s, with an
assertion that `timeout >= poll_time`. Bucket type `"afkstatus"`; payload is exactly
one key, `{"status": "afk"}` or `{"status": "not-afk"}`. Every ping carries
`pulsetime = timeout + poll_time` (185s), deliberately larger than the threshold so a
single afk state survives its own detection latency.

The state machine has exactly three arms, and all three backdate:

```
now       := utcnow()
sinceInput := seconds_since_last_input()
lastInput := now - sinceInput

if afk and sinceInput < timeout:        # no longer AFK
    ping(old state, at=lastInput); flip; ping(new state, at=lastInput + 1ms)
elif not afk and sinceInput >= timeout: # became AFK
    ping(not-afk, at=lastInput); flip; ping(afk, at=lastInput + 1ms, duration=sinceInput)
else:                                   # unchanged
    ping(current, at = afk ? lastInput + 1ms : lastInput, duration = afk ? sinceInput : 0)
```

Three things this buys them: the transition boundary is backdated to when input
actually stopped rather than when the poll noticed; the `+1ms` second ping exists so
latest-event lookups return the *new* state (events are ordered by endtime — §1); and
`duration = sinceInput` while afk makes the event self-describing even if the watcher
restarted mid-away. Threshold semantics are `>=` to enter and `<` to leave.

Input sources, **VERIFIED**: on Windows, `GetLastInputInfo` differenced against
`GetTickCount64` with an explicit branch for the 32-bit DWORD tick wrapping at 2^32 ms;
on macOS, one `CGEventSourceSecondsSinceLastEventType` call covering all HID input.

**Sleep, hibernate and lock: there is no handling at all.** No suspend/resume hook, no
lock-screen detection, no session-change subscription. The only lifecycle logic in the
file is orphan detection via the parent pid.

**VERIFIED — Cattr.** Inactivity limit compared against `getSystemIdleTime()`; on
exceed it emits an activity-proof request — the window is focused, the frame flashes,
the dock bounces, and the user is asked "Are you still working?" A timer at
`(proofDuration + 1) * 1000` fires a negative result and **stops the tracker**. No
retroactive deduction. No crash recovery for an in-flight interval.

### What we do today

`apps/desktop-agent/src/main/idle.ts:106-146`. Threshold inclusive (`>=`, `:115`,
floored at 1). Start backdated to `now - idleSeconds*1000` (`:116`) and never
refreshed once open. Counter-reset detection at `:137-142` with a 2-second tolerance
(`:51`), closing at `lastIdleAt` because the unwitnessed gap belongs to neither
stretch. Explicit breaks outrank inferred idle (`:110`) and a break end clamps a later
backdate (`:123-126`) so a break is not also billed as idle.

**We match or beat their state machine on every point.** The backdating, the inclusive
threshold, the break precedence — all present. What we share with them is the hole.

### Gaps

- **`DEFAULT_IDLE_THRESHOLD_SECONDS = 300`** at `collector.ts:27`, with the comment
  "matching the API's own default". `20260805000001_init_schema.sql:82` declares
  `idle_threshold_seconds integer not null default 120`. **The comment is false.** An
  agent whose policy fetch failed idles at five minutes while every provisioned policy
  idles at two.
- **Sleep and hibernate are entirely unhandled, and over-report work.** Nothing
  subscribes to `powerMonitor.on('suspend' | 'resume' | 'lock-screen' | 'unlock-screen')`;
  `index.ts:458` injects `powerMonitor` only as an idle-time source. Close the lid for
  three hours: the `setInterval` never fires, `Tracker.current` stays open, the work
  session stays open, and on resume `rollLongInterval` (`collector.ts:214-221`) flushes
  **one** activity event spanning the full three hours — `flush()` returns the whole
  open interval, it is not chunked to the five-minute cap. `summariseDay` then counts
  those three hours as tracked *and* active. (Whether the OS idle counter covers the
  sleep span is platform- and build-dependent — **INFERRED** — which is precisely why
  the explicit hook is needed rather than relying on the counter.)
- **A `sampleFocus` outage is silently attributed to the last-seen app.**
  `collector.ts:192-199` logs and returns on error, *before* `rollLongInterval` at
  `:201`. The open interval is neither closed nor capped for as long as the failure
  lasts. Make the adapter throw for 40 ticks (200s) then return a different app: the
  collector enqueues one 200-second event for the app focused before the outage.

### Recommendation — R4

**ADOPT the fixes; there is nothing to adopt from the references here because on this
subject we are already ahead of them.**

1. `collector.ts:27` — reconcile with the policy default. One line, five minutes.
2. `index.ts` near `:458` — subscribe `powerMonitor.on("suspend")` to a new
   `collector.suspend(now)` that drains open focus, idle and break exactly as
   `pause()` does at `collector.ts:283-301`, and `on("resume")` to reset counters and
   let the next tick reopen. Also `lock-screen` / `unlock-screen`, which today reach us
   only as the `locked` idle state (`collector.ts:180-187`) and only suppress
   screenshots. **ActivityWatch has no suspend handling at all** — this is a place we
   can be demonstrably better than the reference rather than merely equal.
3. `collector.ts:189-199` — count consecutive `sampleFocus` failures; after three
   (15 seconds) call `tracker.flush(lastGoodSampleAt)` and enqueue, so an outage
   becomes a gap rather than attributed time.

**REJECT Cattr's activity-proof modal.** Interrupting an employee with a flashing
window and "Are you still working?" is the single most surveillance-coded interaction
in any of the references, and stopping the tracker on a timeout silently loses work
time. Not in scope, and against the positioning rule.

---

## 5. Categorisation

**VERIFIED — `aw-core/aw_transform/classify.py`.** A rule is
`{ select_keys: list[str] | None, ignore_case: bool = False, regex: str | None }`.
The regex is compiled once with `re.UNICODE`, plus `re.IGNORECASE` when set, and — with
an explicit comment — an **empty regex string compiles to nothing rather than a
match-everything pattern**.

Matching: take `data[k]` for each `select_key`, or *every* value in `data` when
`select_keys` is absent; then `regex.search(value)` for each value that is a string,
first hit wins. Unanchored, per-value, non-strings skipped, **not** applied to a joined
string.

Precedence is the part most people get wrong. It is **not** first-match-wins:

```
category := reduce(pick_deepest, matching_tags, ["Uncategorized"])
pick_deepest(t1, t2) := len(t2) >= len(t1) ? t2 : t1
```

Every rule is evaluated. The winner is the category with the **most path segments**,
and on a tie the **later-declared** one wins — the `>=` is deliberate, with the comment
"Always bias against t1, since it could be 'Uncategorized'". The result is written to
`data["$category"]` **in place**. A parallel `tag` function writes every match to
`data["$tags"]`.

**VERIFIED — `aw-webui/src/util/classes.ts`.** The tree: `level_sep = '>'`,
`CLASSIFY_KEYS = ['app', 'title']`, `UNCATEGORIZED = ['Uncategorized']`. A category is
`{ id?, name: string[], name_pretty?, subname?, rule, data?, depth?, parent?, children? }`
where the hierarchy is **derived, not stored**: `parent = name.slice(0, -1)`,
`depth = name.length - 1`, and missing ancestors are synthesised with a non-matching
rule so the tree is always complete. Rules are `{ type: 'regex' | 'none', regex?, ignore_case? }`.

The default tree is a personal-productivity one — Work → Programming → ActivityWatch,
Work → Image / Video / Audio / 3D, Media → Games / Video / Social Media / Music, Comms
→ IM / Email — with named applications like Kdenlive, Ghidra, RimWorld and Nheko. It is
tuned for a hobbyist Linux desktop and carries `data.color` and, on Work only,
`score: 10`.

**There is no productive / neutral / unproductive tri-state.** ActivityWatch
deliberately does not have one. Every commercial product in the category does.

The most important structural fact: **categorisation is a read-time transform, not a
stored column.** Rules live in server settings, get shipped into the query string as a
JSON literal, and are applied inside the query. Changing a rule relabels all history
instantly, with no backfill.

**DOCUMENTED — ActivTrak.** Their metric grid is 2×3, not 1×2: Screen Time =
Productive + Unproductive + Undefined, and each of those splits again into Active
(input detected) and Passive (no input but still work — a call, a training video),
explicitly "not considered idle time", with a default active→passive threshold of two
minutes.

### What we do today

Nothing produces a category. `activity_events.category` exists
(`20260805000001_init_schema.sql`), the API accepts it
(`apps/api/src/routes/activity.ts:12`) and writes it (`:161`), `rankApps` carries it
(`packages/analytics/src/productivity.ts:70,77`) and the report worker selects it —
but `Tracker.close()` (`tracker.ts:186-196`) does not emit the field. A grep of
`apps/desktop-agent/src/main/` for `category` returns **nothing**. Every row ever
written has `category = null`, and every `AppUsage.category` in every API response is
`null`.

`AgentPolicy.trackedCategories` (`packages/types/src/dto.ts:60`) is a dead contract
field: `apps/api/src/routes/devices.ts:88,135` fetches `tracked_categories` and ships
it to every agent, and nothing on the agent reads it.

There is also no productive/neutral/unproductive concept anywhere. `docs/design.md`
lines 176–182 specify a "Work Pattern" block reading *Focused Time 7h 20m /
Collaboration 1h / Idle 40m*. No table, type or function could produce those lines.

### Recommendation — R2

**ADAPT ActivityWatch's engine. Do not adopt it wholesale.**

New `packages/analytics/src/categorize.ts` — pure, no I/O, so it runs unchanged in
Fastify, in Deno Edge Functions, and under Vitest:

```ts
type Productivity = "productive" | "neutral" | "unproductive";

interface CategoryRule {
  id: string;
  path: string[];              // ["Work", "Programming"] — hierarchy, as AW does
  productivity: Productivity;  // the thing AW does NOT have
  priority: number;            // ordered evaluation
  matchApp?: string;           // regex source, per field
  matchDomain?: string;
  matchTitle?: string;
  ignoreCase: boolean;         // default true
}
```

Five deliberate divergences, each with a reason:

1. **Ordered list, first match wins.** Sort by `(priority asc, path.length desc, id asc)`.
   AW's deepest-path-wins-ties-to-last is elegant for a personal tool and
   unexplainable to an admin defending a report to an employee. An ordered list is what
   every commercial settings UI shows, and it is what a person can reason about.
2. **Per-field matching, ANDed.** AW matches one regex against every value in `data`,
   so their Programming rule (`GitHub|Stack Overflow|…`) matches a Slack window whose
   title mentions GitHub. Our columns are already separate — `app_name`, `domain`,
   `window_title` — so the false positive is avoidable for free.
3. **A rule with no match field is rejected at write time** by Zod, not silently
   matched. AW's `type: 'none'` non-matching parent is a footgun.
4. **Domain matching is suffix-aware**: `host === pattern || host.endsWith("." + pattern)`
   when the pattern has no regex metacharacters, else regex. This is what makes the
   `www.`-only domain reduction in `tracker.ts:89-91` survivable — a rule for
   `github.com` catches `gist.github.com`, and a rule for `google.com` catches
   `mail.`, `docs.` and `drive.`.
5. **Fallback is `{ path: ["Uncategorized"], productivity: "neutral" }` — never
   unproductive.** An unknown application is not evidence of anything.

`compileRules(rules) -> CompiledRuleSet` precompiles every `RegExp` and builds an exact
app-name `Map` for the common case. Recompiling per event across twenty thousand events
per report is the difference between a report and a timeout.

Storage: `supabase/migrations/20260805000008_activity_categories.sql` —
`activity_categories(id, company_id, path text[], productivity text check (...),
priority int default 100, match_app, match_domain, match_title, ignore_case bool
default true, created_at, updated_at)`, unique on `(company_id, path)`, indexed on
`(company_id, priority)`. RLS: managers read and write their own company; **employees
read** — they are entitled to see the rules being applied to them, which is
non-negotiable #3 in spirit.

Seed a starter set in `supabase/seed/` written around what this client actually runs.
`docs/design.md:192-196` already names the axes — Development, Communication, Research.
**Do not transcribe ActivityWatch's tree**: it is MPL-2.0 source data and it is tuned
for a hobbyist Linux desktop.

**Where it runs — both, deliberately:**

- **At ingestion** in `apps/api/src/routes/activity.ts`, filling
  `activity_events.category`. The column and the write already exist at `:161`, so
  `rankApps` and the report worker keep working unchanged and the dashboard stays fast.
- **At read time** in `packages/analytics/src/productivity.ts` — `summarisePeriod` and
  `buildTimeline` take an optional `rules?: CompiledRuleSet` and, when present,
  recompute and ignore the stored column. That is how a rule added on Tuesday
  reclassifies Monday with no backfill, which is the entire reason ActivityWatch
  categorises at query time.

Memoise the compiled set per company in the Fastify process, keyed on
`max(updated_at)`; `apps/api/src/plugins/context.ts` is where that belongs. A permanent
SQL backfill is PHASE 2 — say so, do not build it.

**Do not categorise on the agent.** Rules are company data that changes without a
release, and `docs/stack.md` §10's replaceability rule means anything agent-side would
have to be rebuilt for the Android agent and again for a Phase 2 Tauri agent. Either
delete `ActivityEventInput.category` (`dto.ts:87`) or document it as
accepted-and-ignored. Same for `AgentPolicy.trackedCategories` (`dto.ts:60`) — a field
the API ships that nothing reads is a lie in the contract.

UI: `apps/admin-dashboard/src/app/settings/categories/page.tsx` — TanStack Table list,
drag-to-reorder writing `priority`, React Hook Form + Zod rule form, and a **"test this
rule against yesterday's events" preview**. The preview is what makes a rule engine
credible rather than a config screen.

**ADAPT ActivTrak's Productive / Unproductive / Undefined axis — REJECT their
Active/Passive axis for the MVP.** The tri-state we can have today from
`activity_events.category` plus a per-company map. The Active/Passive split needs a
second, shorter threshold in the agent, which is a different workstream and is not in
scope. Their **goal framing** (`actual / expected`) fits `docs/design.md`'s "prefer
work patterns over a score" instruction better than anything else found — and has no
basis in `docs/scope.md`. **PHASE 2.**

### Recommendation — R3, work pattern

`packages/analytics/src/productivity.ts` — add
`workPattern(activity, rules, window) -> { path, seconds, productivity }[]`, collapsed
to depth 1 with a depth-2 drill. That is literally the block at `docs/design.md:176-182`
and it is what should replace `topApps` on the Overview tab. Keep `productivityRatio`
in the type; stop leading the UI with it. **Strictly after R2** — before the rule
engine exists, every event folds into "Uncategorized" and the block says nothing.

---

## 6. Gap repair and title normalisation

**VERIFIED — `aw-core/aw_transform/flood.py`.** Default `pulsetime = 5` seconds,
`negative_gap_trim_thres = 0.1` seconds. Events are deep-copied and sorted by
`(timestamp, duration)`, then adjacent pairs are walked:

| Condition | Action |
| --- | --- |
| Negative gap, equal `data` | Merge into `[min(start), max(end))`; zero the second |
| Negative gap beyond 0.1s, differing `data` | Warn once per batch; do nothing |
| Gap in `(-0.1s, pulsetime]`, equal `data` | The **longer** neighbour absorbs the gap; the shorter is zeroed |
| Gap in `(-0.1s, pulsetime]`, differing `data` | **Split at the midpoint** — each neighbour extends to `e1.end + gap/2` |
| — | Final pass drops zero-duration events; residual overlaps resolve "later event wins" |

Their comment on the midpoint rule is the justification worth keeping: the gap is an
interval of uncertainty, and without evidence that either neighbour owns more of it,
splitting evenly is independent of the surrounding event lengths — i.e. it is the only
fair rule.

**VERIFIED — `aw_transform/simplify.py`.** Title normalisation strips
`^\([0-9]+\)\s*` (unread badges — "(3) Inbox" → "Inbox"), `^(●|\*)\s*` (VS Code and
gedit dirty markers), and rewrites `FPS:\s+[0-9.]+` to `FPS: ...`. The last two apply
only when the key is `title` and the event carries an `app` field.

**VERIFIED — `aw_transform/split_url_events`.** Derives `$protocol`, `$domain`,
`$path`, `$params`, `$options`, `$identifier` from `data["url"]` via `urlparse`, with
`www.` stripped from the netloc and a fallback to the scheme for `file://` and
`about:` "so they don't all cluster as empty". Note it uses `netloc`, which **retains
port and userinfo** — our WHATWG `URL.hostname` in `tracker.ts` is strictly better here.

### What we do today

Nothing bridges gaps. `buildTimeline` (`productivity.ts:93-133`) merges only *within* a
fixed slot. Window titles are stored raw into a 500-character column; there is no
equivalent of `simplify_string`. Two Chrome tabs on the same page with different unread
counts store as distinct titles — harmless for totals today because `Tracker` excludes
title from identity, but it makes the timeline detail column noisy and it will
fragment grouping the moment a categorisation rule matches on title.

### Recommendation

**ADAPT `flood` at query time, not ingestion time** — see `timeline.md` §2 R2, where it
belongs alongside the rest of the reduction pipeline. Our `TICK_INTERVAL_MS` is 5
seconds, which is exactly AW's default pulsetime; that is not a coincidence, it is the
same reasoning about sampling jitter.

**ADOPT title normalisation, on the agent.** `tracker.ts` — a `normaliseTitle()`
applied inside `close()` (`:186`) stripping a leading `^\(\d+\)\s*` unread badge and a
leading `^[●*]\s*` dirty marker. Do it agent-side: it shrinks what leaves the machine,
and a title we never send is a title we never have to defend.

---

## 7. Browser URLs on Windows

**VERIFIED — `aw-webui/src/queries.ts`.** ActivityWatch solves Windows URLs with a
**browser extension**. Browser buckets are discovered by substring match on the bucket
id against a list of about twelve browsers, each mapped to platform-specific app
identifiers plus case-insensitive regexes for `.exe` suffixes. Browser events are then
intersected with the window bucket restricted to that browser's app names — which is
what stops a background tab counting as time. `split_url_events` parses the URL
afterwards, and audible tabs can be unioned into the not-afk mask.

### What we do today

`apps/desktop-agent/src/main/browser-url.ts:88-90` picks a reader per platform. macOS
trusts the AppleScript-read `url` from `get-windows` with no title fallback
(`:101-104`) — a missing URL means a missing Accessibility grant and should surface
rather than be papered over. Windows has no `url` field at all, so
`windowsBrowserUrlReader` (`:113-128`) mines the window title against a 23-name browser
allowlist (`:39-64`), abandons the whole title on a search-results marker (`:139-154`),
and only accepts a segment carrying its own proof — a spelled-out scheme, `host/path`,
or a `www.` prefix (`:179-216`). Domain extraction (`tracker.ts:46-51`) uses WHATWG
`URL`, http/https only, strips exactly `www.`, caps at 253 characters.

### Verdict

**PHASE 2 — and it is a client decision, not ours.** This is CLAUDE.md open item #6.
A browser extension is a second deliverable with its own managed-policy deployment
story and a new ingestion route. Leave `browser-url.ts`'s honest
`fidelity: "window-title"` degradation in place; it is already the correct seam for an
extension to plug into. Named here so it is visibly excluded rather than quietly
missing.

---

## Summary of verdicts

| # | Finding | Verdict | Touches |
| --- | --- | --- | --- |
| R1 | Activity level from per-second `getSystemIdleTime() === 0` | **ADOPT** metric, **ADAPT** segmentation | `main/activity-level.ts`, `collector.ts`, `persistence.ts`, `dto.ts`, migration `…0007`, `routes/activity.ts`, `analytics/activity-level.ts`, `activity-timeline.tsx` |
| R1b | `iohook` / global keystroke hook | **REJECT** | — |
| R2 | Categorisation rule engine, ordered + per-field + tri-state | **ADAPT** | `analytics/categorize.ts`, migration `…0008`, `routes/activity.ts`, `productivity.ts`, `settings/categories/page.tsx` |
| R2b | Categorising on the agent | **REJECT** | `dto.ts:60,87` need deleting or documenting |
| R3 | Work-pattern block replacing the bare score | **ADAPT** (design.md) | `productivity.ts`, Overview tab |
| R4a | Idle threshold default 300 vs 120 | **ADOPT** fix | `collector.ts:27` |
| R4b | `powerMonitor` suspend / resume / lock hooks | **ADOPT** — better than the reference | `index.ts:458`, `collector.ts` |
| R4c | `sampleFocus` outage becomes a gap, not attributed time | **ADOPT** | `collector.ts:189-199` |
| R5 | Title normalisation | **ADOPT** | `tracker.ts:186` |
| R6 | Heartbeats + `pulsetime` ingestion | **REJECT — closed** | — |
| R7 | Browser extension for Windows URLs | **PHASE 2** | — |
| R8 | ActivTrak Active/Passive split; goals | **PHASE 2** | — |
