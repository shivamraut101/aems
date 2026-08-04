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
| Desktop Native         | **Rust**            |
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
│   ├── desktop-agent/       # Tauri + Rust
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

**Framework: Next.js 15 (App Router)**

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

Platforms: Windows, macOS.

**Framework: Tauri + Rust**

```text
Frontend: React + TypeScript
Backend:  Rust
  - Screenshot Capture
  - Active Window Tracking
  - App Tracking
  - Idle Detection
  - Device Info
  - Sync Engine
```

Collects: work sessions, active applications, website usage, screenshots, idle status,
device information, heartbeats.

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
- **Desktop updates:** Tauri Auto Updater

---

## Final Technology Summary

| Category        | Technology               |
| --------------- | ------------------------ |
| Monorepo        | pnpm + Turborepo         |
| Frontend        | Next.js 15               |
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
| Desktop Agent   | Tauri + Rust             |
| Desktop UI      | React + TypeScript       |
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
Windows/macOS Agent       Android Agent
Tauri + Rust             React Native + Kotlin
```

This is the locked MVP stack: simple enough for the 5-day deadline, but structured
enough to evolve into a commercial white-label platform later.
