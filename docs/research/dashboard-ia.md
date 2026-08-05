# Dashboard information architecture

> Navigation, overview, live status, people list, employee detail, master-detail,
> filters, and the employee transparency view.
> Serves `docs/scope.md` §4.1–§4.4.

Read source: Cattr `frontend-application` (`Dashboard/views/Dashboard/Team.vue`,
`views/Dashboard.vue`, five `module.init.js` files, `Users/sections/users.js`,
`Screenshots/views/Screenshots.vue`) at `main`; ActivityWatch `aw-webui`
(`src/route.js`, `src/views/activity/Activity.vue`) at `master`; Kimai
(`src/EventSubscriber/MenuSubscriber.php`, `src/Controller/DashboardController.php`) at
`main`. Vendor documentation: Hubstaff, Apploye, ActivTrak.

---

## 1. Navigation is data, declared with the route and the permission

**VERIFIED — Cattr, across five module initialisers.** Each module declares its route
prefix, a `loadOrder` integer that fixes sidebar position, its routes with auth
metadata, its nav entry keyed to an i18n string plus an icon, and its permissions. One
module registers itself into a **dropdown** rather than as a flat item. **A route a role
cannot use never renders in the sidebar.**

**VERIFIED — Kimai `MenuSubscriber.php`.** Three menus — main, admin, system. Every
single item sits behind a named grant. The structure worth stealing is inside Time
Tracking: *My Timesheets* (`view_own_timesheet`), Quick Entry, Calendar, Export
(`create_export`), *All Timesheets* (`view_other_timesheet`).

That last pair is the finding. **The employee transparency view is not a bespoke screen
— it is the same list with `view_own_*` instead of `view_other_*`.** One feature, two
permissions, not two implementations.

**VERIFIED — Kimai `DashboardController.php`.** Dashboard widgets are permission-filtered
from a default set and ordered by a per-user stored preference, with add / remove /
reset-to-default.

**DOCUMENTED — Hubstaff.** A two-level sidebar: eleven top-level items each with two to
four children — Activity → Screenshots / Apps / URLs; Timesheets → View & edit / Weekly /
Calendar / Approvals; People → Members / Teams; Reports → a directory page listing every
report. Widgets are drag-reorderable and hideable.

### What we do today

`apps/admin-dashboard/src/components/app-shell.tsx:20-28` declares exactly
`docs/design.md`'s seven items — Overview, People, Activity, Devices, Reports, AI
Insights, Settings — as a `const` array rendered **unconditionally**. Three pages exist:
`src/app/page.tsx`, `src/app/people/page.tsx`, `src/app/devices/page.tsx`.
`/activity`, `/reports`, `/insights` and `/settings` all 404. An employee who signs in
sees Devices, Reports and AI Insights.

The active-state logic at `:48` — `href === "/" ? pathname === "/" : pathname.startsWith(href)`
— is already correct for nested detail routes, so nothing there needs changing.

### Recommendation

**ADOPT Kimai's per-item permission gate. ADAPT, do not adopt, their three-menu split** —
seven flat items is a `docs/design.md` decision ("No huge sidebar. Minimal.") and is not
reopened here.

Give each `NAV` entry a `roles: Role[]` field and filter before render. **REJECT
Hubstaff's two-level sidebar and REJECT configurable/reorderable widgets** — the latter
needs a preferences table and a drag library, and `docs/design.md` explicitly warns
against a card farm. One fixed, well-argued Overview beats twenty-six configurable
widgets in a demo.

---

## 2. The employee detail page — 0 of 7 sections exist

**VERIFIED — ActivityWatch `src/route.js` and `Activity.vue`.** Their activity route is
`/activity/:host/:periodLength?/:date?` with a nested child route carrying the view id,
and an empty-path child that redirects. The period control is a button group (day / last
7 days / last 30 days) plus week/month/year behind an ellipsis dropdown that renders as
an extra pressed button when active; the date is an `<input>` with `max` set to today,
flanked by prev/next arrows. Changing the date reconstructs the whole path from host +
period + date + subview and pushes it, **preserving the query string** — category
filters live there.

The consequence: **every state a manager can reach is a shareable link, and browser
back/forward work.** We put nothing anywhere.

**VERIFIED — Cattr `Screenshots.vue`.** Their standalone screenshots module is a flat
three-column grid, fifteen per page, with calendar/user/project/timezone filters, no
grouping and no bulk actions. Named here as the anti-pattern; see `screenshots.md` §6.

**DOCUMENTED — Apploye.** The activity area is exactly three tabs — Screenshots / Apps /
URLs — with project and team-member filters, over a fixed 10-minute grid. That maps
almost exactly onto scope §4.4's tab list.

### What we do today

`apps/admin-dashboard/src/app/people/` contains only `page.tsx`. But
`people/page.tsx:115` and `live-workforce.tsx:78` **both link to `/people/${id}`**. Every
row click in the demo dead-ends on a 404, and scope §4.4's seven sections are 0 of 7.

The differentiator is built and unmounted: `components/activity-timeline.tsx` exports
`ActivityTimeline` (`:44`) and `bucketsToEvents` (`:123`); grep across
`apps/admin-dashboard/src` finds **zero importers** for either. `docs/design.md` names
timeline + AI as the killer feature and instructs spending effort there first.

### Recommendation — the highest-value item in this document

**ADOPT ActivityWatch's URL-as-state pattern, translated to App Router.**

New `apps/admin-dashboard/src/app/(app)/people/[profileId]/layout.tsx` — identity header
per `docs/design.md:112-120` (avatar, name, department, `StatusDot`, device, last sync)
plus a tab strip. **Tabs as nested routes, not local state**: `overview`, `timeline`,
`screenshots`, `apps`, `websites`, `reports`, `devices` — the seven §4.4 sections, one
URL each, with the range in the query (`?from=&to=`) read via `useSearchParams`.

Building them as routes rather than as one monolithic page is what makes §6 below cheap
instead of a rewrite. That is the concrete reason for the decision.

Per tab, and note how much already exists server-side:

| Tab | Data source | Status |
| --- | --- | --- |
| Overview | `GET /api/analytics/productivity` | Route exists, uncalled |
| Timeline | `GET /api/analytics/timeline` → `ActivityTimeline` | Route and component exist, both unused |
| Screenshots | `GET /api/screenshots` (already returns signed URLs) | Route exists, uncalled |
| Apps | `topApps` from `/productivity`, or a dedicated route | Buried in the productivity payload, hard-capped at 10 by `rankApps(..., limit = 10)` |
| Websites | `GET /api/analytics/websites` | Route exists, uncalled |
| Reports | filtered `GET /api/reports` | Route exists, uncalled |
| Devices | already returned by `GET /api/employees/:profileId` (`select("*, devices(*)")`) | Route exists, uncalled |

**Ship the layout + Overview + Timeline in one sitting.** That is the demo. The remaining
five tabs are one or two hours each because the endpoints already exist and return the
right shape.

On the Overview tab, label the fourth tile **"Focused time 7h 20m", not "86%"** —
`docs/design.md:173-181`.

**REJECT Cattr's right-hand interval editor and their "Add time" action.** Letting a
manager edit recorded intervals destroys the evidentiary value of a monitoring record,
is not in scope, and fights non-negotiable #5.

---

## 3. Master–detail in one view

**VERIFIED — Cattr `Team.vue`.** One route, three columns. A top control bar carries a
calendar range picker, a user filter, a project filter and a timezone selector on the
left, with permission-gated actions and an export dropdown on the right. The left column
lists team members with hours worked, **sortable by name or by time worked in either
direction**. The centre toggles between a day view (individual intervals) and a table
view (per-day aggregate across the range). The right column appears **only when
intervals are selected** and becomes a bulk editor. Auto-refresh every 60 seconds. Data
loads only when both users and projects are selected. **Selecting a person never
navigates.**

**VERIFIED — Cattr `Dashboard.vue`.** The dashboard is itself a two-tab shell with
children `timeline` and `team`, where Team is gated on a permission and the parent has
"smart redirect" logic falling back to Timeline when the permission is missing. **The
same URL serves a manager and an employee, and the employee's own view is the default
child, not a separate product.**

**DOCUMENTED — ActivTrak.** Select a user in the top panel and the bottom panel becomes
that user's timeline for the same range, colour-coded by category. No navigation, no
losing your place in the list. This is the strongest IA idea found anywhere in the
survey, and `docs/inspiration.md` already records it.

### Recommendation

**ADOPT the inline drill. ADAPT Cattr's three columns down to two** — their third column
is the interval editor we are rejecting.

New `apps/admin-dashboard/src/app/(app)/activity/page.tsx`, two panes. Master: the roster
with today's hours, sortable by name or by hours (**exactly the two sorts Cattr offers** —
resist adding more). Detail: the selected person's timeline for the same range, in place.
Selection lives in the URL (`?profileId=`), so the drill state is shareable and "Open
full page" is just a link to `/people/:id/timeline` carrying the same range.

**Reuse `ActivityTimeline`. Do not write a second timeline.**

Refresh cadence: 60s on the aggregates, keeping the existing 20s on the live strip
(`lib/api.ts:88`) — presence ages faster than totals.

**REJECT the project/task filter** that Cattr, Hubstaff and Apploye all lead with. We
have no projects in the schema or in scope, and a filter that filters nothing is worse
than no filter.

Also add the same idea to `/people` at `xl` and wider: keep the table on the left, render
the selected person's day ribbon in a right-hand panel, selection as local state. **Do
not replace the detail page with the inline panel** — deep links matter for reports and
for AI-insight callbacks.

---

## 4. Filters — five, not one search box

**VERIFIED — Cattr `Users/sections/users.js`.** Their people grid has columns for full
name, status (custom-rendered), role (custom-rendered) and email, with **two text search
filters** (name, email) plus **three dropdowns**: status active/disabled/any, role
manager/user/auditor/any, type employee/client/any. The edit form blocks deactivating
your own account.

**VERIFIED — ActivityWatch `Activity.vue`.** Their period control is the exact minimal
set worth copying: day / last 7 days / last 30 days as a button group, plus prev/next
arrows and a date input capped at today.

### What we do today

`apps/admin-dashboard/src/store/filters.ts` exports `range`, `department`, `search` and a
`resolveRange()` preset-to-ISO converter (`:33-57`) with presets
`today | yesterday | 7d | 30d`. **Only `search` is consumed** (`people/page.tsx:19-20`);
`range`, `department` and `resolveRange` have zero readers. Every screen is implicitly
"now". A manager cannot look at yesterday, which makes scope §5 reports meaningless from
the UI.

The people search is an in-memory substring scan over the entire roster
(`people/page.tsx:22-30`) — correct at 20 people, wrong at 500. Both tables are
hand-rolled with no sort, no column control and no pagination, while
`@tanstack/react-table` sits installed and unused (along with `recharts`,
`react-hook-form`, `@hookform/resolvers` and `zod`; from `@aems/ui` only `Badge` is
imported).

**No view state is in the URL at all.** No screen is bookmarkable or shareable and
browser back does nothing.

### Recommendation

**ADOPT ActivityWatch's control set, and their URL discipline.**

New `apps/admin-dashboard/src/components/range-picker.tsx` — today / yesterday / 7d / 30d
buttons plus prev/next arrows and a date input with `max=today`.

Then **demote `store/filters.ts` from source of truth to defaults**: read `range` and
`department` from `useSearchParams`, write with `router.replace`. Zustand keeps only
genuinely client-only preferences — column visibility, sidebar state. That is exactly
what CLAUDE.md's "never mirror server data into Zustand" is protecting, and it is
cheaper to do now than after three more screens exist to migrate.

Add Department and Monitoring dropdowns to `/people`, fed from the roster payload it
already has. **ADAPT Cattr's 2-text + 3-dropdown bar; drop their user type (client vs
employee)** — not in our model.

Move both tables onto `@tanstack/react-table` for sort and column visibility. Deliberately
late in the order: it improves screens that already work rather than creating ones that
do not.

**REJECT a per-view timezone selector.** Cattr has one on every screen. Single enterprise
client, one timezone — record the assumption rather than build the control. (The
*subject* timezone on `profiles` is a different matter and is recommended in
`timeline.md` §7.)

---

## 5. Live status cannot ever be idle

`apps/admin-dashboard/src/components/status-dot.tsx:3-15` handles `active | idle |
offline`, and `docs/scope.md` §4.3 shows the amber Idle row explicitly:

```
John   🟢 Active    Windows Laptop
Sarah  🟡 Idle      Android Device
Mike   ⚫ Offline
```

But `apps/api/src/routes/analytics.ts:230` computes `online ? "active" : "offline"`
purely from `devices.last_seen_at` against `OFFLINE_AFTER_MS` (`:16`, two minutes) and
**never reads `idle_events`**. `apps/admin-dashboard/src/lib/api.ts:17` types the field
as `"active" | "offline"`. Leave an agent idle past its threshold and the row stays
green.

### Recommendation

**ADOPT — it is a literal scope clause and the component is already built.**

Join the newest open `idle_events` row per profile in the `/live` handler: offline when
`last_seen_at` is older than `OFFLINE_AFTER_MS`, idle when an open idle event exists,
else active. Widen `LiveWorkforceRow["status"]` in `lib/api.ts:17`. `StatusDot` needs no
change at all.

Roughly two hours, and it is the highest credibility-per-minute item in this document
because the client will look for that amber row specifically.

---

## 6. The employee transparency view

CLAUDE.md non-negotiable #3 says employees read their own data and RLS enforces it — but
an employee who signs in today lands on `/`, which calls two `requireManager` endpoints
(`analytics.ts:163` and `:206`) and renders two error boxes. `docs/design.md`'s third
psychology layer — *Employee → wants transparency and trust* — has no surface at all.

### Recommendation

**ADOPT Kimai's "My Timesheets vs All Timesheets" principle: one feature, two
permissions, not two implementations.**

New `apps/admin-dashboard/src/app/(app)/me/page.tsx` rendering the **same tab components
built in §2**, with `profileId` pinned to the session and the roster hidden, plus the
employee's own consent record and a revoke button hitting the existing
`POST /api/auth/consent/:deviceId/revoke` (`auth.ts:106`).

This is the payoff for building the tabs as routes. Done that way it is ~3 hours; done
against a monolithic detail page it is a rewrite.

**Note the scope position honestly: `/me` is not a `docs/scope.md` clause.** It serves
CLAUDE.md non-negotiable #3 and `docs/design.md`'s third psychology layer. It is called
out as such rather than smuggled in under §4.

---

## 7. Auth — nothing else is creditable without it

There is no `src/middleware.ts`, no `/login` route, no sign-out, no session hook, and no
call to `GET /api/auth/me` (`auth.ts:14`) anywhere. `lib/api.ts:58-73` sends requests
unauthenticated when no session exists, and the pages then render "Check that the API is
running" (`people/page.tsx:51`, `devices/page.tsx:38`) — **a 401 is reported to the user
as an outage.** Open the app in a clean browser profile and this is the first thing you
see.

Also dead: `lib/api.ts:37 useApi()` (the `AemsClient` wrapper) has zero call sites —
every hook uses the local `getJson()` (`:58-73`) instead.

### Recommendation

**ADOPT — build this first.** It blocks everything else and it is not optional for a
demo.

- `apps/admin-dashboard/src/middleware.ts` — `@supabase/ssr` `createServerClient`,
  refresh session cookies, redirect unauthenticated to `/login` and
  authenticated-on-`/login` to `/`.
- `src/app/login/page.tsx` — React Hook Form + Zod + `supabase.auth.signInWithPassword`.
  All three dependencies are already installed and unused.
- `src/lib/session.ts` — `useSession()` over `GET /api/auth/me`, returning
  `{ profileId, role, companyId, fullName }`.
- Move the three existing pages under `src/app/(app)/` with an `(app)/layout.tsx` holding
  `AppShell`, so `/login` renders outside the sidebar (`layout.tsx:26` currently wraps
  everything).
- `app-shell.tsx` — the `roles` filter from §1, plus a user menu with sign-out.
- `lib/api.ts:58-73` — distinguish 401 from a transport failure so the error copy stops
  blaming the API.

The main risk is `@supabase/ssr` cookie handling in Next 15 middleware, not the UI.

---

## 8. What is missing behind the other screens

Recorded because each is a small gap with a scope clause attached.

- **Devices has no filter and no detail route.** Scope §7 asks for installed
  applications; `device_applications` exists in the schema and
  `POST /api/devices/applications` (`devices.ts:227`) writes it, and **no screen renders
  it**. A `devices/[deviceId]` page in the Datadog-inventory style of
  `docs/design.md:206-218` closes §7.
- **No manager read path for work sessions.** `work_sessions` is written by
  `POST /api/activity/sessions` (`activity.ts:39`) and read only inside the `/overview`
  aggregate. There is no GET, so an employee Overview tab cannot show clock-in/clock-out
  — which scope §2.2 spells out as "Work Started: 09:05 AM".
- **No standalone app-usage endpoint.** `topApps` is buried inside the productivity
  payload (`dto.ts:169`) and hard-capped at 10 by `rankApps(..., limit = 10)`. Scope §2.4
  wants an app list as a first-class view.
- **No AI summary read path.** `ai_summaries` exists with kind, period, provider, model
  and content; no API route reads it, and `page.tsx:41-45` hardcodes placeholder prose
  into `ai-insight.tsx` — the one component in the app that is fully built. See
  `reports-analytics.md` §7 F.

---

## 9. Exception surfacing — the idea worth taking, without the route

**DOCUMENTED — Hubstaff.** Their widget catalogue is not twenty-six totals. It includes
**Low Activity** (names the users whose activity was low last week), **Late & Missed
Shifts**, **Who's Online**, **Recent Activity** (recently active users *with their
screenshots*), and **Timesheets to approve**. Their home screen answers *"who needs my
attention"*, not only *"what are the numbers"*.

Ours shows four totals and a roster. Nothing tells a manager where to look. CLAUDE.md
lists a Notification Edge Function owning idle and offline alerts, and it has no
destination in the UI.

### Recommendation

**ADAPT the shape, REJECT the route.** No `docs/scope.md` clause supports an `/alerts`
page, and §8 keeps advanced work out. The honest MVP answer is **one exception strip
inside Overview** — "2 people idle over 45m today", "1 device offline since 09:20" —
derived from data we already have. Treat even that as optional polish, not a step in the
build order.

---

## 10. What is already right

Worth recording so a refactor does not lose it.

- **KPI discipline.** `components/kpi-row.tsx:19` is a single `<dl>` grid with `gap-px`
  over `bg-border` — one bordered group, not four floating cards. It is the only card
  surface in the app. `docs/design.md`'s "do not make cards everywhere" is already
  honoured.
- **Live Workforce is a real table** — Employee / Status / Device / Last sync, with an
  `sr-only` caption, skeleton rows and an empty state, polling every 20 seconds. Rows
  link to `/people/{profileId}`.
- **The Overview order matches `docs/design.md`'s Dashboard Home block exactly**:
  greeting and long date, four KPIs, live workforce, AI summary.
- **Active-nav logic already handles nested detail routes** (`app-shell.tsx:48`).
- **Design tokens are complete** (`globals.css:13-98`) and Inter is wired via
  `next/font`.

---

## Build order

Each step is demoable on its own and unblocks the next.

| Step | Work | Serves |
| --- | --- | --- |
| 0 | Auth shell (§7) | §4 preamble, `docs/stack.md` §6, non-negotiable #3 |
| 1 | `/people/[profileId]` with seven tabs; ship layout + Overview + Timeline first (§2) | §4.4, and §2.2/2.4/2.5/2.7/§5/§7 through its tabs |
| 2 | Idle in live status (§5) | §4.3 |
| 3 | `/activity` master–detail (§3) | §4.1, §4.3 |
| 4 | Range control + real filters + URL state (§4) | §5, §4.1 |
| 5 | `/reports` and `/insights` (see `reports-analytics.md` §7 G) | §5, §6 |
| 6 | `/settings` and `/me` (§6) | §4.2; non-negotiable #3 |
| 7 | TanStack Table upgrade + device detail (§4, §8) | §7 |

Steps 0–3 are roughly 3.5 days and cover §4.1–§4.4 end to end. Steps 4–7 are roughly four
days more and cover §5, §6, §7 and the transparency obligation.

---

## Summary of verdicts

| # | Finding | Verdict | Touches |
| --- | --- | --- | --- |
| §7 | Auth shell: middleware, `/login`, session hook, `(app)` route group | **ADOPT** | `middleware.ts`, `app/login/`, `lib/session.ts`, `app-shell.tsx`, `lib/api.ts` |
| §2 | Employee detail page, tabs as nested routes, URL-as-state | **ADOPT** (ActivityWatch) | `app/(app)/people/[profileId]/*` |
| §5 | Idle in `/live` | **ADOPT** | `routes/analytics.ts:206`, `lib/api.ts:17` |
| §3 | Two-pane master–detail on `/activity` | **ADOPT** ActivTrak, **ADAPT** Cattr | `app/(app)/activity/page.tsx` |
| §4 | Range picker + filters + URL state, Zustand demoted | **ADOPT** AW control set, **ADAPT** Cattr filter bar | `range-picker.tsx`, `store/filters.ts`, `people/page.tsx` |
| §6 | `/me` transparency view from the same components | **ADOPT** Kimai's one-feature-two-permissions | `app/(app)/me/page.tsx` |
| §1 | Role-aware nav | **ADOPT** Kimai's gate | `app-shell.tsx:20` |
| §8 | Device detail + installed apps | **ADOPT** | `app/(app)/devices/[deviceId]/page.tsx` |
| §9 | Exception strip on Overview | **ADAPT** shape, **REJECT** the route | `app/(app)/page.tsx` |
| §1 | Configurable / reorderable dashboard widgets | **REJECT** — preferences table + drag library; design.md warns against a card farm | — |
| §2 | Interval editing / manual time entry | **REJECT** — non-negotiable #5, out of scope | — |
| §3 | Project / task / client dimension in filters | **REJECT** — not in schema, not in scope | — |
| §4 | Per-view timezone selector | **REJECT** for MVP — record the assumption | — |
| §1 | Hubstaff's two-level sidebar | **REJECT** — `docs/design.md` picked a minimal flat sidebar | — |
| — | A dedicated `/alerts` route | **PHASE 2** | — |
| — | Location / map widgets | **REJECT** — non-negotiable #6 | — |
| — | SSO, compliance screens | **REJECT** — §8 Later | — |
