# AEMS — Project Instructions

Advanced Employee Monitoring System. Windows + macOS desktop agents, an Android
employee app, and a web admin dashboard, on a Supabase-first backend.

Three source documents govern this repo. They are the authority; this file is their
operational distillation. When one of them disagrees with this file, the document
wins and this file gets corrected.

| Document | Governs |
| --- | --- |
| `docs/stack.md` | The locked technology stack — *how* it is built |
| `docs/scope.md` | The locked MVP feature set and priorities — *what* is built |
| `docs/design.md` | The design direction for every user-facing surface |

`docs/inspiration.md` is **reference, not authority** — projects worth studying for
architecture and UX. Take ideas, never code: Kimai is AGPL-3.0 and ActivityWatch is
MPL-2.0, and copying either into a white-label commercial product is a licensing
problem, not a style one.

All four are imported below, so they load with this file rather than being fetched
on demand:

@docs/stack.md
@docs/scope.md
@docs/design.md
@docs/inspiration.md

All three are **locked for the MVP**. Do not substitute a technology for a "better"
one, do not add a library that duplicates something already listed, do not reintroduce
anything from the *Forbidden* list, and do not build features outside `docs/scope.md`
— anything else is Phase 2, after the client demo. If a locked choice genuinely blocks
the work, stop and raise it; don't route around it.

---

## Locked stack

| Category         | Technology                            |
| ---------------- | ------------------------------------- |
| Package manager  | pnpm                                  |
| Monorepo         | Turborepo                             |
| Language         | TypeScript (Kotlin for Android native modules) |
| Frontend         | Next.js 16 (App Router)               |
| UI               | Tailwind CSS + shadcn/ui              |
| Client state     | Zustand                               |
| Server state     | TanStack Query                        |
| Forms            | React Hook Form + Zod                 |
| Charts           | Recharts                              |
| Backend API      | Fastify + TypeScript                  |
| Database         | Supabase PostgreSQL                   |
| DB access        | Supabase Client SDK                   |
| Auth             | Supabase Auth                         |
| Authorization    | Supabase Row Level Security           |
| Realtime         | Supabase Realtime                     |
| Storage          | Supabase Storage                      |
| Background jobs  | Supabase Edge Functions               |
| Desktop agent    | Electron + React + TypeScript         |
| Android agent    | React Native + Expo (native: Kotlin)  |
| Tables           | TanStack Table                        |
| Icons            | Lucide                                |
| Font             | Inter                                 |
| AI               | OpenAI / Claude / Gemini              |
| Code quality     | ESLint + Prettier                     |
| Git hooks        | Husky + lint-staged                   |
| Testing          | Vitest                                |
| Deploy           | Vercel (web) + VPS (API) + Supabase   |

## Forbidden

Do not introduce these — each was ruled out deliberately:

- **Prisma or any other ORM.** Supabase Client SDK is the only database access path;
  it already gives Postgres, type generation, auth integration, and realtime.
- **Redis / BullMQ / any separate queue or worker runtime.** Background work runs as
  Supabase Edge Functions.
- **Tauri or Rust** in the desktop agent. Reversed on 2026-08-05: Electron is the
  MVP choice (see `docs/stack.md` §10 for the reasoning). Tauri is the *Phase 2*
  option, not a thing to reach for now.
- **A hand-rolled auth system** (custom JWT signing, password hashing, session tables).
  Supabase Auth owns authentication; RLS owns authorization.
- **A second storage provider** alongside Supabase Storage. R2 is a possible *future*
  swap of the provider only — do not build for it now.

## Repository layout

```text
apps/
  admin-dashboard/   Next.js 16 admin dashboard
  api/               Fastify backend
  desktop-agent/     Electron + React + TS (Windows, macOS)
  android-agent/     React Native + Expo

packages/
  ui/                shadcn/ui components shared across surfaces
  supabase/          Supabase client factories + generated DB types
  auth/              shared auth helpers (session, role checks)
  sdk/               typed client for the Fastify API, used by the agents
  types/             shared domain types
  analytics/         productivity / activity computation
  config/            ESLint preset + tsconfig bases

supabase/
  migrations/        SQL migrations
  functions/         Edge Functions (workers)
  seed/              seed data
```

New shared code goes in an existing package before a new one is created.

## Per-surface rules

### apps/admin-dashboard (Next.js 16)

- App Router only.
- **The request gate is `src/proxy.ts`, exporting `proxy`** — Next 16's rename of
  `middleware.ts`. It refreshes the Supabase session cookie, redirects the signed-out
  to `/login`, and holds anyone carrying a temporary password on `/set-password`. It
  is a UX boundary, never the security one.
- **Turbopack is the default builder.** It rejects CommonJS inside a `"type": "module"`
  package where webpack quietly allowed it, so a shared `.js` config file must use
  `export default`.
- Server state through TanStack Query. Zustand is for client-only state —
  dashboard filters and user preferences. Never mirror server data into Zustand.
- All forms: React Hook Form + Zod. The Zod schema is the single source of validation
  truth; derive types from it rather than declaring them twice.
- Charts: Recharts.
- UI is built from shadcn/ui primitives in `packages/ui`. Don't add a second component
  library.

### apps/api (Fastify)

Owns business logic, agent communication, event ingestion, device authentication,
report APIs, and AI processing.

Route namespaces:

```text
/api/auth  /api/employees  /api/devices  /api/activity
/api/screenshots  /api/reports  /api/analytics
```

### Database & multi-tenancy

- Every business table carries `company_id`.
- Every business table has RLS enabled with policies for the three roles:
  **Super Admin**, **Manager**, **Employee**. A table without RLS is a bug, not a
  todo.
- Schema changes are SQL migrations in `supabase/migrations/`. No ORM migrations.
- Stored: companies, users, employees, devices, work sessions, activity events,
  screenshot metadata, reports, AI summaries.

### Realtime

Supabase Realtime drives live employee status, online/offline state, activity
updates, dashboard refresh, and notifications.

### Storage

Supabase Storage, keyed by tenant:

```text
<company-id>/<employee-id>/screenshots/
<company-id>/<employee-id>/reports/
```

### Background workers (Supabase Edge Functions)

| Worker         | Handles                                                     |
| -------------- | ----------------------------------------------------------- |
| Screenshot     | screenshot validation, metadata processing, timeline creation |
| Report         | daily reports, weekly reports, team analytics                 |
| AI Summary     | activity summarization, productivity insights, manager reports |
| Notification   | idle alerts, offline alerts, report notifications             |

### apps/desktop-agent (Electron + React + TypeScript)

Node.js main process handles OS integration; React renderer handles UI; they talk over
Electron IPC. Main-process modules: `screenshot`, `tracker`, `idle`, `device`, `sync`.

Collects work sessions, active applications, website usage, screenshots, idle status,
device information, heartbeats.

Auto-launch on startup, tray application, background sync. Updates ship via
electron-updater.

**Keep OS integration out of the renderer.** Node APIs belong in the main process
behind IPC — `nodeIntegration` stays off and `contextIsolation` stays on. A monitoring
agent that renders remote content with Node access in the renderer is a remote-code-
execution hole.

**The agent is replaceable by design.** It speaks to the API only through the event
contract in `@aems/types`. Nothing agent-specific may leak into the API, schema, or
dashboard — that is what keeps a Phase 2 Tauri rewrite from becoming a backend
rewrite.

### apps/android-agent (React Native + Expo)

Android only. Kotlin native modules for app usage tracking, battery information,
device details, and network state; React Native calls into them. Anything needing an
Android API goes in the Kotlin layer, not a JS shim.

### AI layer

`activity events → analytics processing → AI model → summary storage`.
Produces daily employee summaries, weekly productivity reports, activity insights.
Provider is pluggable (OpenAI / Claude / Gemini) — keep the call site behind one
interface so the provider can be swapped.

## Data flow

```text
Desktop Agent ─┐
               ├─→ Fastify API ─→ Supabase ─→ Admin Dashboard
Android Agent ─┘
```

Agents talk to the Fastify API, never to Supabase directly. The dashboard reads
Supabase directly for realtime subscriptions and goes through the API for
business operations.

## Commands

```sh
pnpm install
pnpm dev         # turbo run dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format
pnpm check       # both static checks below
```

Node >= 20, pnpm pinned via `packageManager` in the root `package.json`.

Two checks catch what the compiler cannot, because both cross a boundary made of
strings. Run them with `pnpm check` before any push.

| Check | Catches |
| --- | --- |
| `pnpm check:wiring` | A table, column or embed the API or an Edge Function names that the schema does not have |
| `pnpm check:routes` | An `/api/...` path the dashboard or SDK calls that Fastify never registers |
| `pnpm check:schema` | A table the API names that the **live database** does not have — i.e. a migration committed but never applied |

The second exists because that failure already shipped: the dashboard called
`GET /api/analytics/insights` and `GET /api/policies/current`, neither of which
existed, and both 404s rendered as ordinary empty states — so the AI Insights page
and the Settings policy block were permanently blank with nothing reporting an error.

So did the third. `…0014_location_tracking.sql` was written, reviewed and committed
but never applied, and `GET /api/activity/locations` answered `500 Could not find the
table 'public.location_points' in the schema cache` to every caller. The first two
checks could not see it — both read the schema this repo *believes* in, and so does
the code, so a migration that exists on disk and nowhere else looks perfectly wired.
`check:schema` is the only one that asks the database instead. It **skips**, rather
than failing, without `SUPABASE_SERVICE_ROLE_KEY` or a network, so a contributor with
no production credentials can still run `pnpm check`.

---

## Design rules

From `docs/design.md`. These bind every surface — dashboard, desktop agent, Android app.

- **Position it as an AI workforce intelligence platform, not surveillance.** This is
  a copy rule as much as a design one: no "spy", "surveil", or "catch" language in UI
  text, docs, or commit messages.
- **Palette:** navy `#0F172A` primary (trust), indigo `#6366F1` accent (**reserved for
  AI surfaces only** — it is how a reader tells model output from recorded fact),
  emerald `#10B981` success, amber `#F59E0B` warning, `#F8FAFC` / `#020617`
  backgrounds. No bright-blue SaaS styling.
- **Inter**, 600 headings / 500 labels / 400 body. 8px radius, thin borders, dense
  tables, subtle hover.
- **Cards for KPIs, tables for operations, timeline for history, charts for trends.**
  Not everything is a card.
- **Prefer descriptive work patterns over a bare productivity percentage** — "Focused
  time 7h 20m" reads as insight; "86%" reads as a score.
- The **timeline + AI insight** experience is the product's differentiator. Spend
  effort there before anywhere else.
- Avoid: glassmorphism, gradients, heavy animation, huge rounded cards.

## Non-negotiables

Compliance behaviour that is not up for refactoring. Changing any of it is the
client's call.

1. **No collection without consent.** A non-revoked `consent_records` row tied to the
   in-force policy version is required. Agents gate themselves *and* the API rejects
   ingestion — the server is the enforcement point, because an agent is a binary on
   someone's laptop.
2. **Monitoring is never silent.** Permanent tray icon on desktop, undismissable
   foreground-service notification on Android.
3. **Employees can read their own data.** Enforced in RLS, not just the UI.
4. **Revocation is immediate.** Withdrawn consent, a disabled employee, or a revoked
   device stops collection on the agent's next request.
5. **The audit log is append-only.** No update or delete policy exists on it.
6. **Location tracking is in scope as of 2026-08-07, and is the most sensitive thing
   this product collects.** `docs/scope.md` §3.5 marks it optional and client-dependent;
   the client asked for it by name on 2026-08-07, choosing current location **plus
   history** and collection while the app is closed. Geofencing — the third item in
   §3.5 — was offered and deferred, and no zones table exists.
   Three things follow and none of them are optional:
   - **An employee sees their own trail and nobody else's.** Non-negotiable #3 applied
     to the one dataset where getting it wrong follows someone home.
   - **Points are written only against a device whose consent is in force**, gated by
     `assertConsent` on the same path as every other event.
   - **Retention is deliberately unset.** A location history kept forever is a
     different product from one kept for 30 days. That is the client's call to make
     explicitly, and it is still outstanding — chase it before the demo.

## Scope decisions taken after the documents were locked

The source documents are the authority and are not edited without the client saying so.
Where a decision has since overridden one, it is recorded here and `docs/` is left alone
until they confirm the edit.

| Date | Decision | What it overrides |
| --- | --- | --- |
| 2026-08-05 | **Website restriction is in scope.** The admin panel can set rules that block sites, enforced by a managed browser extension. | `docs/scope.md` §8 lists control features under *Later — not part of MVP* |
| 2026-08-05 | **The dashboard may go beyond `docs/design.md`** where a change demonstrably improves the product. Asked for by name: "if you can improve the design rather than just docs/design.md and if you have better ideas according to this project please proceed." | `docs/design.md` was previously followed to the letter |
| 2026-08-06 | **The Android agent's tab bar may be translucent.** Asked for by name ("make the tab bar like ios liquid glass"), and confined to `apps/android-agent/src/components/TabBar.tsx` — chosen over glass everywhere, which was offered and declined. The rest of the app takes iOS *structure* only: collapsing large titles, grouped inset lists, hairline separators, spring presses. | `docs/design.md` lists **glassmorphism** under *Avoid*, and the 2026-08-05 permission above named only the dashboard |
| 2026-08-08 | **Next.js 15 → 16, and the dashboard's request gate is `src/proxy.ts`.** Asked for by name: "the next latest should be used… must be using proxy.ts". `docs/stack.md` §3 is amended in place rather than overridden here, because the client authorised the document edit. Carried three consequences: the `middleware.ts` → `proxy.ts` rename, Turbopack becoming the default builder (which rejected `module.exports` in the ESM `packages/ui/tailwind-preset.js`), and Node ≥ 20.9 / React ^19, both already met. | `docs/stack.md` locked **Next.js 15** |
| 2026-08-07 | **That tab bar is a floating capsule, not an edge-to-edge bar.** Asked for by name against a reference screenshot. It is inset from both screen edges, fully rounded (radius = half its height), hairline-bordered, and carries a spring-driven pill behind the selected tab. Same file, same exception — `radius` in `theme.ts` is untouched and still 8, so nothing else in the app can pick this radius up by accident. | `docs/design.md` locks an **8px radius** and lists **huge rounded cards** under *Avoid* |

Two parts of the design direction are **not** loosened by that, because neither is a
style preference:

- **Indigo stays reserved for AI surfaces.** It is how a reader tells a model's
  inference from a recorded fact, on a screen where that distinction decides whether
  someone is treated fairly. Spending it on a button would be a legibility regression.
- **The compliance surfaces keep their wording and prominence** — consent, the visible
  indicator, what-is-collected. Those answer to the *Non-negotiables* above, not to
  taste. This is also the limit on the translucency exception: the *Avoid* rule it
  bends is a legibility rule, so nothing a reader has to actually read — consent, the
  privacy list, the break/finished/revoked notices — sits on a translucent surface.
  A navigation bar carries four words the reader already knows; a disclosure does not.

Two things that decision does **not** do, and must not be allowed to drift into:

- **Nothing else from §8 is in scope.** Not remote control, USB control, file
  monitoring, software deployment, MDM or endpoint protection. Website restriction was
  asked for by name; the rest was not.
- **It does not change the product's framing.** `docs/design.md` positions this as
  workforce intelligence, not surveillance, and enforcement makes that framing *more*
  fragile rather than less. An employee must be able to see which policy blocked a page
  and who to ask about it — a bare "blocked" screen is precisely what the design
  direction rules out.

The reason it is one piece of work rather than two: on Windows there is no supported way
to read a browser's address bar, so website *tracking* already needed a managed
extension. The mechanism that reports a URL is the mechanism that can refuse it.

**`docs/scope.md` §8 still says otherwise.** Confirm the document edit before the demo.

## Open items

Ask before acting on these.

1. **Storage provider conflict.** `docs/scope.md` §2.3 says screenshots go to
   "Cloudflare R2 / S3 compatible storage"; `docs/stack.md` §8 says Supabase Storage
   for the MVP with R2 as a possible later swap. The code follows `docs/stack.md`
   (Supabase Storage, single `aems` bucket). Confirm which is right before the demo.
2. ~~Nothing has been run against a live database.~~ **Resolved 2026-08-05.** All
   nine migrations are applied to project `dayyrqcfktwwnkttlres` (Postgres 17.6) and
   the RLS suite in `supabase/tests/rls_isolation.sql` passes **35/35**, now including
   `category_rules` — an employee or a manager who could edit a scoring rule could
   rewrite their own numbers without touching an activity row, so that table is tested
   like a privilege boundary, not like reference data. **Re-run the suite after any
   policy change or any new column on `profiles`** — it already caught one
   privilege-escalation hole (migration `...0005`).
3. ~~The desktop agent buffers nothing to disk.~~ **Resolved 2026-08-05.** Observed
   events are journalled to `state/pending-events.ndjson` before any network call and
   removed only on API confirmation; today's spans, the open focus interval, the open
   idle stretch, the open break and the capture schedule live in `state/day-state.json`
   and are restored by `Collector` before its first tick; a 400-quarantined batch lands
   in `state/dead-letters.json`; and `AemsClient` now takes a per-request deadline
   (15 s in the agent). **One gap remains:** buffered screenshot *bytes* are still
   in-memory only — a crash loses unsent frames, because a JPEG does not belong in an
   NDJSON log. Frames need a blob directory keyed by `clientEventId` before that closes.
4. **`main/index.ts` and `preload/index.ts` still have no tests.** Everything else the
   old wording named is now covered: `main/config.ts` (26 tests), every renderer file
   under test, and the collector's own `start()`/`stop()` timer driven by fake timers
   rather than by hand. What is left is Electron glue that needs a real runtime —
   `ElectronIndicatorSurface`, `ElectronCapturer`, `createPermissionMonitor` and the
   wiring in `index.ts` itself. Those need a manual smoke test on **both** platforms
   before the demo, not a unit test.
5. ~~The visible-indicator guarantee is weaker than it reads.~~ **Resolved 2026-08-05.**
   An always-on-top, click-through, all-workspaces indicator window is created before
   collection can begin and shown for exactly as long as the loop is recording; failing
   to show it stops the agent, as a failed tray already did. The tray image is now
   template-marked on macOS and an unreadable asset throws instead of yielding the empty
   image Electron hands back. **Still owed:** `resources/` holds one 32x32 non-template
   PNG. macOS wants a designed `trayTemplate.png` + `@2x` at 16/32, and Windows wants a
   multi-size `.ico`; the current asset is marked as a template rather than drawn as one.
6. **Website tracking on Windows is honest but near-empty, and still needs a client
   decision.** `get-windows` reads a tab URL only on macOS, over AppleScript. The agent
   now *says so* rather than implying otherwise: `AgentPermissions.websiteTracking`
   carries the platform's fidelity, the consent gate drops the "Website domains you
   visit" promise on a machine that cannot keep it, and the status screen states the
   limit. The Windows reader recovers a domain only from the rare title that carries
   one. Closing the gap properly is a managed browser extension (Chrome/Edge
   `ExtensionInstallForcelist`, Firefox `force_installed`) — UIAutomation was evaluated
   and rejected. Scope §2.5 needs the client's call on the extension.
7. **The packaged agent has never been launched.** `release/win-unpacked/AEMS Agent.exe`
   builds and the native chain resolves inside it, but nobody has run it. The Electron
   glue — indicator window, capturer, permission monitor, tray — has no automated
   coverage and cannot get any without a real runtime. Smoke-test on **both** platforms
   before the demo. **macOS has never been built at all**; `electron-builder --mac`
   refuses on Windows.
8. **One mutation survives.** `main/indicator.ts:71` — making `show()` unconditional
   leaves the suite green, so nothing proves the indicator is hidden when it should be.
   The inverse (failing to show) is covered.
9. **Leaked-password protection is off.** Supabase Auth can reject passwords found in
   the HaveIBeenPwned corpus; the project currently does not. It is a dashboard toggle
   (Auth → Policies), not code, and it is the client's call for their employees — but
   it is the cheapest real security win available before the demo.
10. **The `rls_auto_enable` advisor warning is a false positive — do not re-chase it.**
    `get_advisors` reports `public.rls_auto_enable()` as a `SECURITY DEFINER` function
    callable by `anon` over `/rest/v1/rpc/`. It is not reachable: the function returns
    `event_trigger`, and PostgREST rejects the call with HTTP 400 `cannot display a
    value of type event_trigger` for both anon and authenticated (verified 2026-08-05).
    It is also Supabase's own platform trigger (`ensure_rls`), not ours, and its only
    effect is to *enable* RLS on new public tables. Left in place deliberately.
11. **`DEVICE_TOKEN_SECRET` buys nothing and should become a per-device token.**
    `lib/device-token.ts` HMACs `{deviceId, companyId, profileId, issuedAt}` so a
    token can be verified statelessly — but `requireDevice` (`plugins/context.ts:105`)
    re-reads the `devices` row on *every* request regardless, and non-negotiable #4
    means it always must. The one benefit of an HMAC is therefore unreachable by
    design, while the costs are real: a shared secret on every host, forgeable tokens
    for any known device id if it leaks, and a rotation that re-enrols the whole fleet.
    **Replace with** a random per-device token stored hashed on `devices` and looked up
    by hash — the same single query, no shared secret, no env var, per-device rotation.
    Roughly one migration (column + unique index), both enrolment routes,
    `requireDevice`, and `devices.test.ts` already covers the surface. Not urgent: the
    per-request revocation read is what actually secures this today. Also note
    `verifyDeviceToken` never checks `issuedAt`, so tokens never expire.
12. **Data integrity defects found 2026-08-07, against live data — see the audit.**
    Ranked, all reproduced: (a) an unbounded idle stretch records overnight machine-on
    time as *idle*, so one employee's day read 14h 2m idle / 1.1% activity — the agent
    caps a break at 3h but nothing caps idle, and the API's `STALE_IDLE_AFTER_MS` is
    applied only by `/live`; (b) `/analytics/overview` returned `activeNow: 1` beside
    `workingToday: 0, totalHoursToday: 0` because it counts only sessions that *started*
    today and then sums wall-clock with no union across devices and no idle/break
    subtraction; (c) work sessions never close when an agent is killed (3/3 open, oldest
    47.7h) and there is no server-side reaper; (d) a `CHECK` violation returns 500, which
    `sync.ts:63` classifies as retry, so one clock-skewed event wedges that device's queue
    forever — and the agent uses wall-clock `Date` with no monotonic fallback; (e) the
    ingestion path has no tests, including the consent gates at `activity.ts:241` and
    `:332`; (f) 3 of 4 profiles in the live database are seed data. Root cause under
    (a)/(b): **four different definitions of "hours"** — tray unions sessions, Android
    uses wall clock since clock-in, the timeline unions activity/idle/break and ignores
    sessions, the overview KPI sums raw session time. One reduction should serve all four.

Delete each item once it is resolved.
