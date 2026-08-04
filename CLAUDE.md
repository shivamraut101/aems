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

All three are imported below, so they load with this file rather than being fetched
on demand:

@docs/stack.md
@docs/scope.md
@docs/design.md

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
| Frontend         | Next.js 15 (App Router)               |
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
  admin-dashboard/   Next.js 15 admin dashboard
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

### apps/admin-dashboard (Next.js 15)

- App Router only.
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
```

Node >= 20, pnpm pinned via `packageManager` in the root `package.json`.

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
6. **Location tracking is not implemented.** `docs/scope.md` marks it optional and
   client-dependent. Do not add it without an explicit decision.

## Open items

Ask before acting on these.

1. **Storage provider conflict.** `docs/scope.md` §2.3 says screenshots go to
   "Cloudflare R2 / S3 compatible storage"; `docs/stack.md` §8 says Supabase Storage
   for the MVP with R2 as a possible later swap. The code follows `docs/stack.md`
   (Supabase Storage, single `aems` bucket). Confirm which is right before the demo.
2. ~~Nothing has been run against a live database.~~ **Resolved 2026-08-05.** All
   migrations are applied to project `dayyrqcfktwwnkttlres` (Postgres 17.6) and the
   RLS suite in `supabase/tests/rls_isolation.sql` passes. **Re-run that suite after
   any policy change or any new column on `profiles`** — it already caught one
   privilege-escalation hole (migration `...0005`).
3. **The desktop agent buffers nothing to disk.** The Tauri + Rust implementation is
   gone and the Electron agent is implemented end to end: the main-process modules
   (`tracker`, `idle`, `screenshot`, `device`, `sync`, `session`) are real, and
   `main/collector.ts` is the loop that drives them — consent re-checked every tick,
   work session opened on clock-in and closed on shutdown, stop signals obeyed. What is
   still missing is durability: the sync queue, the open focus interval and the day's
   idle/break spans live in memory only, so a crash loses them and a mid-day restart
   under-reports the totals until the server-side report catches up. There is also no
   request timeout in the SDK and no dead-letter file for a 400-quarantined batch.
4. **Untested surfaces in the desktop agent.** `main/index.ts`, `preload/index.ts`,
   `main/config.ts` and every renderer file have no tests — which is where the
   compliance surface physically lives (tray, consent wiring, the `safeStorage`
   allowlist that keeps the device token out of plaintext). The collector's
   `start()`/`stop()` timer is also undriven: every test calls `tick()` by hand, so
   nothing proves the agent collects on its own.
5. **The visible-indicator guarantee is weaker than it reads on both platforms.**
   On Windows 11 22H2+ third-party tray icons default into the overflow flyout and
   no API pins them out; on macOS the tray image is not a template image, so it can
   render unreadably in some menu-bar themes. Non-negotiable #2 is not fully
   satisfied by the tray alone — an always-on-top indicator window is the piece that
   makes the claim true.
6. **Website tracking has no Windows implementation.** `get-windows` reads browser
   URLs via AppleScript, macOS only. Scope §2.5 needs a client decision: a managed
   browser extension, a UIAutomation native module, or accepting window-title-derived
   data on Windows.
7. **Android toolchain unverified.** The Android SDK has not been confirmed present,
   so the Expo agent has never been built.

Delete each item once it is resolved.
