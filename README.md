# AEMS — Advanced Employee Monitoring System

PrimeX Build - AEMS

Monitoring for **company-owned devices**, with **employee consent** and compliance
controls built in from the start (versioned policies, consent records, audit log).

## Architecture

```
        Web Admin Dashboard (apps/web)
                  |
           API + Auth Layer (apps/api)
                  |
   -------------------------------------
   |                                   |
Desktop Agent                    Android Agent
Windows/macOS                    Company Phones
(apps/desktop-agent)             (apps/mobile-agent)
   |                                   |
   -------------------------------------
                  |
           Activity Engine (apps/api/src/activity)
                  |
   -------------------------------------
   |
Database (packages/database, Postgres + Prisma)
   |
Screenshot storage (object storage, see .env)
```

## Structure

- `apps/api` — NestJS backend: auth, device inventory, consent, policies, activity engine
  (work sessions, app tracking, idle detection, screenshots, timeline), audit log.
- `apps/web` — Next.js admin dashboard.
- `apps/desktop-agent` — Electron agent for Windows/macOS. Shows a blocking consent
  notice before any tracking starts, a persistent tray icon while monitoring is active,
  and reports app-focus, idle and screenshot events to the API.
- `apps/mobile-agent` — Android (Kotlin) agent for company-owned phones. Native Gradle
  project, not part of the pnpm workspace. Consent screen + foreground service with a
  persistent notification, reporting app-usage events via `UsageStatsManager`.
- `packages/types` — Shared TypeScript domain types (User, Device, ConsentRecord,
  ActivityEvent, IdleEvent, Screenshot, Policy, AuditLogEntry, TimelineEntry).
- `packages/database` — Prisma schema (Postgres) + client, shared by `apps/api`.
- `packages/config` — Shared ESLint preset and `tsconfig` bases.

## Requirements

- Node >= 20, pnpm 10 (`packageManager` pinned in root `package.json`)
- PostgreSQL (see `.env.example` for `DATABASE_URL`)

## Getting started

```sh
pnpm install
cp .env.example .env        # fill in DATABASE_URL etc.
pnpm db:migrate              # apply Prisma schema
pnpm dev                     # runs apps/api and apps/web in watch mode
```

`apps/mobile-agent` is opened separately in Android Studio (not driven by `pnpm dev`).

## Common scripts

- `pnpm build` / `pnpm dev` / `pnpm lint` / `pnpm typecheck` — run across all workspaces via Turborepo.
- `pnpm db:generate` / `pnpm db:migrate` — Prisma client generation / migrations.

## Priority (locked MVP scope)

**Critical:** Desktop Agent, Work Tracking, Screenshot Capture, Application Tracking,
Idle Detection, Timeline, Admin Dashboard, Android Monitoring App.
**High:** Reports. **Medium:** Device Inventory, AI Summary. **Later:** Advanced Security.

## Compliance notes

- Every device must have a corresponding `ConsentRecord` tied to the `Policy` version
  the employee agreed to; both agents block tracking until consent is recorded.
- Both agents show a persistent, visible indicator while monitoring is active (tray
  icon on desktop, foreground-service notification on Android) — monitoring must never
  be silent on-device.
