# Final Tech Stack — Employee Monitoring Platform (MVP)

> Source document as provided. `CLAUDE.md` is the operational distillation of this
> file — if the two ever disagree, this document wins and `CLAUDE.md` gets corrected.

**Product Scope:**

- Windows Desktop Agent
- macOS Desktop Agent
- Android Employee Monitoring App
- Web Admin Dashboard
- Supabase-first architecture

---

## 1. Monorepo & Development Setup

| Layer                  | Technology          |
| ---------------------- | ------------------- |
| Package Manager        | **pnpm**            |
| Monorepo               | **Turborepo**       |
| Main Language          | **TypeScript**      |
| Desktop Runtime        | **Electron**        |
| Android Native Modules | **Kotlin**          |
| Code Quality           | ESLint + Prettier   |
| Git Workflow           | Husky + lint-staged |

---

## 2. Repository Structure

```text
employee-monitoring/
├── apps/
│   ├── admin-dashboard/     # Next.js
│   ├── api/                 # Fastify
│   ├── desktop-agent/       # Electron + React + TypeScript
│   └── android-agent/       # React Native + Expo
├── packages/
│   ├── ui/
│   ├── supabase/
│   ├── auth/
│   ├── sdk/
│   ├── types/
│   ├── analytics/
│   └── config/
└── supabase/
    ├── migrations/
    ├── functions/
    └── seed/
```

---

## 3. Web Admin Dashboard

**Framework: Next.js 16 (App Router)**

> **Amended 2026-08-08, at the client's instruction: 15 → 16.** The original document
> locked 15. Three things changed with it and they are load-bearing:
>
> - **`middleware.ts` is now `proxy.ts`**, exporting `proxy` rather than `middleware`.
>   Same request, same position in the pipeline. Next still resolves the old name, but
>   running on a deprecated convention is how a build starts warning and then breaks.
> - **Turbopack is the default builder**, and it is strict about module format where
>   webpack was forgiving. `packages/ui/tailwind-preset.js` used `module.exports`
>   inside a `"type": "module"` package — always a mismatch, tolerated until now.
> - **Node ≥ 20.9 and React ^19**, both of which this repo already exceeded.

Purpose: admin dashboard, employee management, monitoring analytics, reports, settings.

**UI: Tailwind CSS + shadcn/ui** — dashboard cards, tables, forms, modals, filters,
settings pages.

**Data management: TanStack Query** — API calls, caching, server state.

**Client state: Zustand** — dashboard filters, user preferences.

**Forms:** React Hook Form + Zod.

**Charts: Recharts** — productivity charts, activity graphs, reports.

---

## 4. Backend API

**Framework: Fastify + TypeScript**

Responsibilities: business logic, agent communication, event ingestion, device
authentication, report APIs, AI processing.

```text
/api/auth
/api/employees
/api/devices
/api/activity
/api/screenshots
/api/reports
/api/analytics
```

---

## 5. Database

**Primary database: Supabase PostgreSQL**

Stores companies, users, employees, devices, work sessions, activity events,
screenshot metadata, reports, AI summaries.

**ORM / database access: Supabase Client SDK. No Prisma.**

Reason — Supabase already provides PostgreSQL, type generation, auth integration,
and realtime.

---

## 6. Authentication & Authorization

**Authentication: Supabase Auth** — email/password login, session management, JWT.

**Authorization: Supabase Row Level Security (RLS)**

Roles: Super Admin, Manager, Employee.

Multi-tenant support: `company_id` on all business tables.

---

## 7. Realtime System

**Supabase Realtime** — live employee status, online/offline state, activity updates,
dashboard refresh, notifications.

```text
Desktop Agent → Fastify API → Supabase → Admin Dashboard
```

---

## 8. Storage

**Supabase Storage** — screenshots, reports, export files.

```text
storage/
  company-id/
    employee-id/
      screenshots/
      reports/
```

**Future migration:** possible upgrade to Cloudflare R2. Only the storage provider is
replaced; no architecture changes.

---

## 9. Background Processing / Workers

No Redis/BullMQ. Use **Supabase Edge Functions**.

- **Screenshot Worker** — screenshot validation, metadata processing, timeline creation.
- **Report Worker** — daily reports, weekly reports, team analytics.
- **AI Summary Worker** — activity summarization, productivity insights, manager reports.
- **Notification Worker** — idle alerts, offline alerts, report notifications.

---

## 10. Desktop Agent

Platforms: Windows, macOS. (Linux is supported by Electron but is out of scope —
see `docs/scope.md` §1.)

**Framework: Electron + React + TypeScript**

```text
Electron
    |
React + TypeScript UI  (renderer)
    |
Node.js Main Process   (IPC)
    |
OS APIs
```

```text
src/
├── main/            # Node.js main process
│   ├── index.ts
│   ├── screenshot.ts
│   ├── tracker.ts
│   ├── idle.ts
│   ├── device.ts
│   └── sync.ts
├── renderer/        # React UI
│   ├── dashboard/
│   ├── login/
│   └── settings/
└── shared/
    └── types/
```

Capabilities: full-screen and multi-monitor screenshot capture, active application and
window-title tracking with usage duration, keyboard/mouse idle detection, device info
(OS version, CPU, RAM, device name), auto-launch on startup, tray application, and
background sync.

Collects: work sessions, active applications, website usage, screenshots, idle status,
device information, heartbeats.

### Why Electron over Tauri for the MVP

Not a claim that Electron is technically superior — the project constraints favour it.

| Category | Electron | Tauri + Rust |
| --- | --- | --- |
| Windows / macOS support | Excellent | Excellent |
| Development speed | **Faster** | Slower |
| Developer availability | **Very high** | Lower |
| Active app tracking / idle detection | **Easier** | More native work |
| App size / RAM | Larger | **Smaller** |
| Security | Requires hardening | **Stronger** |
| Long-term enterprise product | Good | **Better** |

The hard parts of this agent are OS integrations, not UI, and Electron's Node
ecosystem already covers them. With a 5-day deadline, one client, and Android plus a
dashboard also to deliver, the bottleneck is implementation and debugging speed —
not runtime performance. Electron reduces delivery risk.

### Phase 2 evolution path

If this becomes a multi-tenant commercial product (50,000+ monitored employees),
revisit Tauri + Rust for installer size, memory, and the stronger security model.

**Keep that door open by design:** the agent talks to the API only through the event
contract in `@aems/types` (`ActivityEventInput`, `IdleEventInput`, `HeartbeatInput`,
device enrolment). The backend must never care whether an event came from Electron,
Tauri, or Android — so a v2 desktop agent can replace v1 without touching the API,
the schema, or the dashboard.

---

## 11. Android Employee App

Platform: Android only.

**Framework: React Native + Expo**, native layer in **Kotlin** for app usage tracking,
battery information, device details, network state.

```text
React Native → Kotlin Native Modules → Android APIs
```

---

## 12. AI Layer

Provider options: OpenAI, Claude, Gemini.

Features: daily employee summary, weekly productivity report, activity insights.

```text
Activity Events → Analytics Processing → AI Model → Summary Storage
```

---

## 13. Deployment

- **Frontend:** Vercel
- **Backend API:** DigitalOcean VPS / Railway / Render / AWS
- **Database:** Supabase Cloud
- **Storage:** Supabase Storage
- **Desktop updates:** electron-updater (auto updater)

---

## Final Technology Summary

| Category        | Technology               |
| --------------- | ------------------------ |
| Monorepo        | pnpm + Turborepo         |
| Frontend        | Next.js 16               |
| UI              | Tailwind CSS + shadcn/ui |
| State           | Zustand                  |
| Data Fetching   | TanStack Query           |
| Forms           | React Hook Form + Zod    |
| Charts          | Recharts                 |
| Backend         | Fastify + TypeScript     |
| Database        | Supabase PostgreSQL      |
| Auth            | Supabase Auth            |
| Security        | Supabase RLS             |
| Realtime        | Supabase Realtime        |
| Storage         | Supabase Storage         |
| Background Jobs | Supabase Edge Functions  |
| Desktop Agent   | Electron                 |
| Desktop UI      | React + TypeScript       |
| Desktop IPC     | Electron IPC             |
| Android App     | React Native + Expo      |
| Android Native  | Kotlin                   |
| AI              | OpenAI / Claude / Gemini |
| Deployment      | Vercel + VPS + Supabase  |

---

## Final Architecture

```text
                   Admin Dashboard
                       Next.js
                          |
                    Fastify API
                          |
                  Supabase Platform
        ------------------------------------
        |          |          |             |
    Database     Auth     Storage     Realtime
        |
  Edge Functions
        |
--------------------------------
|                              |
Electron Agent            Android Agent
Windows/macOS             React Native + Kotlin
```

This is the locked MVP stack: simple enough for the 5-day deadline, but structured
enough to evolve into a commercial white-label platform later.
