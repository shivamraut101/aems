# AEMS — AI Workforce Intelligence Platform

PrimeX Build — AEMS.

Activity, productivity and device insight for **company-owned devices**, with
**employee consent** and compliance controls built in from the start: versioned
policies, consent records, an append-only audit log, and a monitoring indicator that
cannot be hidden.

## Source documents

Three documents govern this repository. When code and document disagree, the document
wins.

- [`docs/stack.md`](docs/stack.md) — the locked technology stack
- [`docs/scope.md`](docs/scope.md) — the locked MVP feature scope and priorities
- [`docs/design.md`](docs/design.md) — the design direction for every user-facing surface

[`CLAUDE.md`](CLAUDE.md) is the operational distillation of all three.

## Architecture

```
                   Admin Dashboard
                    Next.js 15
                         |
                    Fastify API
                         |
                 Supabase Platform
      -------------------------------------
      |          |          |             |
  Database     Auth     Storage     Realtime
      |
 Edge Functions
      |
-------------------------------
|                             |
Windows/macOS Agent      Android Agent
Tauri + Rust             React Native + Kotlin
```

Agents talk to the Fastify API and never to Supabase directly — they hold no Supabase
credentials, so consent and revocation are enforced in exactly one place.

## Structure

- `apps/admin-dashboard` — Next.js 15 dashboard. Tailwind + shadcn/ui, TanStack Query
  for server state, Zustand for filters, Recharts, TanStack Table.
- `apps/api` — Fastify backend: device enrolment and auth, consent, event ingestion,
  screenshots, reports, analytics, audit log.
- `apps/desktop-agent` — Tauri + Rust agent for Windows and macOS. React frontend,
  Rust modules for screenshot capture, window tracking, idle detection, device info
  and the sync engine. Blocking consent gate, permanent tray indicator.
- `apps/android-agent` — React Native + Expo app for company Android phones, with
  Kotlin native modules for `UsageStatsManager`, battery, device and network state.
  Blocking consent screen, foreground-service notification.
- `packages/types` — generated Supabase schema types plus domain aliases and wire DTOs.
- `packages/supabase` — Supabase client factories and storage path helpers.
- `packages/auth` — session resolution and role logic (mirrors the RLS policies).
- `packages/sdk` — typed client for the Fastify API, used by agents and dashboard.
- `packages/analytics` — productivity, timeline and interval computation (unit-tested).
- `packages/ui` — shadcn/ui components and the shared Tailwind preset.
- `packages/config` — shared ESLint preset and tsconfig bases.
- `supabase/` — SQL migrations, RLS policies, storage setup, seed data, and the four
  Edge Function workers (screenshot, report, AI summary, notification).

## Requirements

- Node >= 20, pnpm 10 (`packageManager` pinned in the root `package.json`)
- A Supabase project (or Docker, for the local stack)
- **Rust toolchain** — only to build `apps/desktop-agent`
- **Android SDK / Android Studio** — only to build `apps/android-agent`

## Getting started

```sh
pnpm install
cp .env.example .env          # fill in your Supabase keys

pnpm db:push                  # apply supabase/migrations to your project
pnpm db:types                 # regenerate packages/types/src/database.types.ts

pnpm dev                      # admin dashboard + api in watch mode
```

For a local Supabase stack instead of the hosted project (needs Docker running):

```sh
pnpm db:start                 # boots Postgres, Auth, Storage, Realtime
pnpm db:reset                 # re-applies migrations and seeds
```

The agents are built separately:

```sh
pnpm --filter @aems/desktop-agent dev      # needs the Rust toolchain
pnpm --filter @aems/android-agent android  # needs the Android SDK
```

## Common scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` / `build` / `lint` / `typecheck` / `test` | Across all workspaces via Turborepo |
| `pnpm db:start` / `db:stop` / `db:reset` | Local Supabase stack |
| `pnpm db:push` / `db:diff` | Apply / author migrations |
| `pnpm db:types` | Regenerate schema types after a migration |
| `pnpm format` | Prettier across the repo |

## Priority (locked MVP scope)

**Critical:** Desktop Agent, Work Tracking, Screenshot Capture, Application Tracking,
Idle Detection, Timeline, Admin Dashboard, Android Monitoring App.
**High:** Reports. **Medium:** Device Inventory, AI Summary. **Later:** Advanced
Security.

Full detail in [`docs/scope.md`](docs/scope.md).

## Compliance notes

These are load-bearing, not nice-to-haves. Changing any of them is a decision for the
client, not a refactor.

- Every device needs a non-revoked `consent_records` row tied to the `policies`
  version the employee agreed to. Both agents gate themselves on it, **and** the API
  rejects ingestion without it — an agent is a binary on someone's laptop, so the
  server is where the rule is actually enforced.
- Both agents show a permanent, visible indicator while monitoring runs: a tray icon
  on desktop, a foreground-service notification on Android. Neither can be dismissed.
- Employees can read their own activity, screenshots and summaries. This is enforced
  in RLS, not in the UI.
- Revoking consent, disabling monitoring for an employee, or revoking a device all
  take effect on the agent's next request — no restart, no waiting for a token to
  expire.
- Location tracking is **not** implemented. `docs/scope.md` marks it optional and
  client-dependent; it stays out of the schema until someone decides it is in.
