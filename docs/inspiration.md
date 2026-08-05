# Inspiration — what to study, and what to take from each

> Source document as provided. Reference material, not a specification: when this
> disagrees with `docs/scope.md`, `docs/stack.md` or `docs/design.md`, those win.

**Take ideas, not code.** Study these for architecture, UX, workflow and feature
breadth, then implement from scratch against our own contracts.

> ⚠️ **Licence discipline is not optional.** Several of these are copyleft —
> Kimai is **AGPL-3.0** and ActivityWatch is **MPL-2.0**. Pasting AGPL source into
> this product would oblige us to release the whole thing under AGPL, which is
> fatal for a white-label commercial platform. Read them, understand the approach,
> close the tab, write our own. Never copy a file, a function body, or a schema
> verbatim, and never vendor one of these as a dependency without checking the
> licence against the commercial plan first.

---

## The shortlist

### 1. ActivityWatch — highest priority (architecture)

<https://github.com/ActivityWatch/activitywatch>

The best reference for how to structure collectors. Key repos: `aw-server`,
`aw-webui`, `aw-client`, `aw-watcher-window`, `aw-watcher-afk`, `aw-transform`.

**Learn:** the watcher architecture (collectors split cleanly from server and UI),
the event model, timeline implementation, data aggregation, activity
categorisation, AFK/idle detection, browser tracking.

**Maps to us:** `apps/desktop-agent/src/main/*` — our `tracker` / `idle` /
`screenshot` modules are our "watchers", and the separation we already enforce
(pure logic + injected OS adapters) is the same idea.

### 2. Cattr — highest priority (closest analogue)

<https://github.com/cattr-app> — org, not a single repo. The URL in the original
document (`cattr-app/cattr`) 404s. The pieces are
[`server-application`](https://github.com/cattr-app/server-application) and
[`frontend-application`](https://github.com/cattr-app/frontend-application).

The nearest open-source equivalent to what we are building: screenshot
monitoring, desktop agents (Windows/macOS/Linux), web dashboard, employee
timeline, productivity analytics, self-hosted.

> 🚫 **Licensed SSPL.** Not OSI-approved, and the most aggressive copyleft of
> anything on this list — it reaches the whole service stack, not just the binary.
> Read it for ideas only. Do not copy code, do not vendor it, and do not use it as
> a dependency in a commercial white-label product.

**Learn:** dashboard layout, employee page, screenshot gallery, event ingestion,
time tracking, overall UI flow.

### 3. EmpMonitor

<https://github.com/EmpCloud/EmpMonitor>

**Learn:** feature breadth — what a monitoring product is expected to cover.
Do **not** copy its architecture.

### 4. Kimai — **AGPL-3.0, read-only**

<https://github.com/kimai/kimai>

Not a monitoring system. **Learn:** reports, dashboard organisation, time
reports, filters, export, admin UX. Do **not** use it for monitoring logic, and
do not copy code.

---

## UX references (commercial, observe only)

| Product | Study |
| --- | --- |
| [Apploye](https://apploye.com) | **Primary UI inspiration** — dashboard, employee details, screenshot viewer, timeline, reports, productivity pages |
| [Hubstaff](https://hubstaff.com) | Navigation (among the cleanest in the industry), employee profile, team dashboard, timeline |
| [ActivTrak](https://www.activtrak.com) | Enterprise dashboard, workforce analytics, AI insights, executive reports, heatmaps |
| [WakaTime](https://github.com/wakatime) | Time aggregation, timeline, analytics — developer productivity only, not monitoring |

## Design-system references

| Product | Study |
| --- | --- |
| [Grafana](https://grafana.com) | Analytics dashboards, filtering, charts, real-time visualisation |
| [Datadog](https://www.datadoghq.com) | Dense enterprise UI, timeline, event stream, logs, tables, status indicators |
| [Linear](https://linear.app) | Typography, sidebar, tables, spacing, empty states, keyboard-first UX |

---

## What to take from where

| Project | What to learn |
| --- | --- |
| ActivityWatch | Event collection architecture, watchers, idle detection |
| Cattr | Monitoring workflow, screenshots, employee timeline |
| Apploye | Overall product UX, reports, screenshots |
| Hubstaff | Navigation, employee pages |
| ActivTrak | Enterprise analytics, manager dashboards |
| Kimai | Time reports and filtering |
| Grafana | Charts and analytics layouts |
| Datadog | Event streams and operational dashboards |
| Linear | Modern SaaS design language |
| EmpMonitor | Feature coverage and monitoring concepts |

```text
ActivityWatch  ->  Desktop watchers
Cattr          ->  Monitoring engine
Apploye        ->  UX
Hubstaff       ->  Employee experience
ActivTrak      ->  Analytics
Grafana        ->  Charts
Linear         ->  Design system
Datadog        ->  Enterprise dashboard
```

---

## How to use this

Study each area separately rather than trying to absorb a whole product at once:

1. **ActivityWatch** → event collectors and watcher architecture
2. **Cattr** → monitoring engine, screenshots, workflows
3. **Apploye + Hubstaff + ActivTrak** → UX, information architecture, analytics
4. **Linear + Datadog + Grafana** → design system and enterprise dashboard patterns

The result should feel original while borrowing the strongest idea from each.

**Where this and `docs/design.md` overlap, `docs/design.md` is the decision.** It
already picked Datadog + Linear + Stripe as the direction and named the palette,
type and component rules. Use this file to understand *why* those references were
chosen and to go deeper on a specific problem — not to reopen a settled call.

---

## Research findings — 2026-08-05

What was actually read, and what it changes. Everything below is a *finding*, not
yet a decision.

### ActivityWatch: heartbeats + `pulsetime` beat closed intervals under crash

Their watchers do **not** emit a finished interval when focus changes. They send a
**heartbeat** on every poll, and the server **coalesces** two adjacent events when
`data` is identical and the timestamps fall inside a `pulsetime` window — the
merged event keeps the earlier timestamp and grows its `duration`.

| | Our `tracker.ts` | ActivityWatch |
| --- | --- | --- |
| Emits | one closed interval, on focus **change** | a heartbeat every poll |
| Events produced | few | many, coalesced server-side |
| **Crash mid-interval** | **the entire interval is lost** | at most one poll window is lost |

That last row matters. An employee who works two hours in one window and then
loses power has, under our model, two hours of unrecorded work — and the
persistence agent currently mid-flight is patching that by writing the open
interval to disk. Heartbeats solve the same problem architecturally instead: the
event is already durable after the first poll, because every subsequent poll only
*extends* it.

Their event shape is minimal and worth comparing to ours: `timestamp` (ISO8601
UTC), `duration` (seconds), `data` (JSON, schema per bucket type). One bucket per
watcher per host — our `device_id` + per-table split is the same idea by another
name.

**Not adopting this unilaterally.** It is a real architectural change to an
already-tested module and would move idempotency from `client_event_id` to
server-side coalescing. Recorded here so the choice is deliberate.

### Apploye: screenshots are a time grid, not a gallery

Screenshots are grouped into **fixed 10-minute intervals** (`8:00 AM – 8:10 AM`),
and each interval carries: project, monitor count (multi-display), and an
**activity percentage**, colour-banded — red 0–30%, yellow 30–60%, green 60–100%.
Around it sit clock-in/out, active time, **neutral time** and idle time.

Two things we do not have:
- **A third state.** They distinguish active / **neutral** / idle. Our model is
  binary. Neutral is the honest bucket for "the machine was in use but we cannot
  call it productive", and it is much fairer than forcing every second into one of
  two columns.
- **A fixed interval grid.** Our timeline buckets are configurable seconds; theirs
  is a consistent 10-minute unit that the screenshot, the activity % and the app
  list all share. One unit across three views is what makes them line up.

Their activity page splits into exactly three sections — **Screenshots / Apps /
URLs** — with filters on project, member, task and date. That maps almost exactly
onto the tabs `docs/scope.md` §4.4 already specifies.

### ActivTrak: master–detail in one view, not two pages

The strongest IA idea found: **select a user in the top panel and the bottom panel
becomes their timeline** for the same range, each interval colour-coded by
category. No navigation, no losing your place in the list.

Our People page currently follows the conventional route — click a row, go to a
detail page. ActivTrak's inline drill is materially faster for the actual job a
manager does, which is scanning a team and stopping on the one person who looks
wrong.

Also worth taking: an **Active vs Passive** split (finer than active/idle), a
configurable column set, a "show top N categories" slider rather than a fixed
list, and framing time against a **goal** (`Activity Type vs Goal (Hrs/Day)`)
rather than as a bare number — which fits `docs/design.md`'s instruction to prefer
work patterns over a naked productivity score.

### Licence positions, confirmed

| Project | Licence | Consequence |
| --- | --- | --- |
| Cattr | **SSPL** | Not OSI-approved; reaches the whole service stack. Ideas only. |
| Kimai | **AGPL-3.0** | Copying obliges us to release AEMS under AGPL. Fatal for white-label. |
| ActivityWatch | **MPL-2.0** | File-level copyleft — the mildest here, still not to be copied. |

None of these can be borrowed from at the source level. The architecture ideas are
free; the code is not.
