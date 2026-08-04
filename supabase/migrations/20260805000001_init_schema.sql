-- AEMS initial schema.
--
-- Multi-tenant employee monitoring. Every business table carries company_id and is
-- protected by RLS (see 20260805000002_rls_policies.sql).
--
-- Primary key strategy:
--   * uuid  for tenant/identity rows that agents and clients pass around by ID
--           (companies, profiles, devices, policies, consent_records)
--   * bigint identity for high-volume append-only event tables — sequential keys keep
--           index locality, which random uuidv4 would destroy at millions of rows.

create extension if not exists pgcrypto with schema extensions;

-- Helper functions live here so PostgREST never exposes them: it only serves the
-- schemas in its db-schemas config (public by default).
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------------

create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function private.set_updated_at();

-- Profile rows mirror auth.users. Supabase Auth owns credentials; there is
-- deliberately no password column here.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  company_id  uuid not null references public.companies (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'employee'
              check (role in ('super_admin', 'manager', 'employee')),
  department  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index profiles_company_id_idx on public.profiles (company_id);
create unique index profiles_company_email_key on public.profiles (company_id, lower(email));

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Policy & consent (compliance surface)
-- ---------------------------------------------------------------------------

-- Versioned monitoring configuration. Consent is recorded against a version, so
-- editing a live policy must mint a new version rather than mutate an old one.
create table public.policies (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references public.companies (id) on delete cascade,
  version                     text not null,
  name                        text not null,
  screenshot_interval_seconds integer not null default 300
                              check (screenshot_interval_seconds >= 30),
  idle_threshold_seconds      integer not null default 120
                              check (idle_threshold_seconds >= 30),
  tracked_categories          text[] not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (company_id, version)
);

create index policies_company_id_idx on public.policies (company_id);

create trigger policies_set_updated_at
  before update on public.policies
  for each row execute function private.set_updated_at();

create table public.devices (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  platform      text not null check (platform in ('windows', 'macos', 'android')),
  label         text not null,
  os_version    text not null default '',
  agent_version text not null default '',
  enrolled_at   timestamptz not null default now(),
  last_seen_at  timestamptz,
  status        text not null default 'active'
                check (status in ('active', 'offline', 'revoked')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index devices_company_id_idx on public.devices (company_id);
create index devices_profile_id_idx on public.devices (profile_id);
create index devices_company_status_idx on public.devices (company_id, status);

create trigger devices_set_updated_at
  before update on public.devices
  for each row execute function private.set_updated_at();

-- Proof that a device's user was shown the policy and agreed to monitoring.
-- Agents must refuse to collect anything until a non-revoked row exists here.
create table public.consent_records (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  device_id      uuid not null references public.devices (id) on delete cascade,
  policy_version text not null,
  method         text not null
                 check (method in ('in_app_dialog', 'onboarding_portal', 'signed_document')),
  ip_address     inet,
  consented_at   timestamptz not null default now(),
  revoked_at     timestamptz
);

create index consent_records_company_id_idx on public.consent_records (company_id);
create index consent_records_device_id_idx on public.consent_records (device_id);
create index consent_records_profile_id_idx on public.consent_records (profile_id);

-- One live consent per device; revoked rows stay for the audit trail.
create unique index consent_records_active_device_key
  on public.consent_records (device_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Activity data (high volume, append-heavy)
-- ---------------------------------------------------------------------------

create table public.work_sessions (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id) on delete cascade,
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  device_id    uuid not null references public.devices (id) on delete cascade,
  clock_in_at  timestamptz not null default now(),
  clock_out_at timestamptz,
  created_at   timestamptz not null default now(),
  check (clock_out_at is null or clock_out_at >= clock_in_at)
);

create index work_sessions_company_id_idx on public.work_sessions (company_id);
create index work_sessions_device_id_idx on public.work_sessions (device_id);
create index work_sessions_profile_clock_in_idx
  on public.work_sessions (company_id, profile_id, clock_in_at desc);

-- One open session per device.
create unique index work_sessions_open_device_key
  on public.work_sessions (device_id)
  where clock_out_at is null;

-- A single application/window-focus interval reported by an agent.
create table public.activity_events (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  device_id       uuid not null references public.devices (id) on delete cascade,
  work_session_id bigint references public.work_sessions (id) on delete set null,
  app_name        text not null,
  window_title    text,
  url             text,
  category        text,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  -- Agents retry offline batches; this makes ingestion idempotent.
  client_event_id uuid not null,
  created_at      timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

create index activity_events_company_id_idx on public.activity_events (company_id);
create index activity_events_work_session_id_idx on public.activity_events (work_session_id);
create index activity_events_device_started_idx
  on public.activity_events (device_id, started_at desc);
create index activity_events_profile_started_idx
  on public.activity_events (company_id, profile_id, started_at desc);
create unique index activity_events_client_event_key
  on public.activity_events (device_id, client_event_id);

create table public.idle_events (
  id               bigint generated always as identity primary key,
  company_id       uuid not null references public.companies (id) on delete cascade,
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  device_id        uuid not null references public.devices (id) on delete cascade,
  idle_start_at    timestamptz not null,
  idle_end_at      timestamptz,
  -- Derived, so it can never drift from the timestamps it summarises.
  duration_seconds integer generated always as (
    case
      when idle_end_at is null then null
      else (extract(epoch from (idle_end_at - idle_start_at)))::integer
    end
  ) stored,
  client_event_id  uuid not null,
  created_at       timestamptz not null default now(),
  check (idle_end_at is null or idle_end_at >= idle_start_at)
);

create index idle_events_company_id_idx on public.idle_events (company_id);
create index idle_events_device_id_idx on public.idle_events (device_id);
create index idle_events_profile_start_idx
  on public.idle_events (company_id, profile_id, idle_start_at desc);
create unique index idle_events_client_event_key
  on public.idle_events (device_id, client_event_id);

-- Metadata only. Binary lives in the `screenshots` storage bucket; storage_path is
-- the object key within it.
create table public.screenshots (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  device_id       uuid not null references public.devices (id) on delete cascade,
  work_session_id bigint references public.work_sessions (id) on delete set null,
  captured_at     timestamptz not null default now(),
  storage_path    text not null,
  thumbnail_path  text,
  blurred         boolean not null default false,
  client_event_id uuid not null,
  created_at      timestamptz not null default now()
);

create index screenshots_company_id_idx on public.screenshots (company_id);
create index screenshots_work_session_id_idx on public.screenshots (work_session_id);
create index screenshots_device_captured_idx
  on public.screenshots (device_id, captured_at desc);
create index screenshots_profile_captured_idx
  on public.screenshots (company_id, profile_id, captured_at desc);
create unique index screenshots_client_event_key
  on public.screenshots (device_id, client_event_id);

-- ---------------------------------------------------------------------------
-- Derived output: reports, AI summaries, audit trail
-- ---------------------------------------------------------------------------

create table public.reports (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id) on delete cascade,
  -- null = whole-company report
  profile_id   uuid references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('daily', 'weekly', 'team')),
  period_start timestamptz not null,
  period_end   timestamptz not null,
  status       text not null default 'pending'
               check (status in ('pending', 'ready', 'failed')),
  storage_path text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (period_end >= period_start)
);

create index reports_company_id_idx on public.reports (company_id);
create index reports_profile_id_idx on public.reports (profile_id);
create index reports_company_period_idx on public.reports (company_id, kind, period_start desc);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function private.set_updated_at();

create table public.ai_summaries (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id) on delete cascade,
  profile_id   uuid references public.profiles (id) on delete cascade,
  kind         text not null check (kind in ('daily', 'weekly', 'insight')),
  period_start timestamptz not null,
  period_end   timestamptz not null,
  provider     text not null check (provider in ('openai', 'claude', 'gemini')),
  model        text not null,
  content      text not null,
  created_at   timestamptz not null default now(),
  check (period_end >= period_start)
);

create index ai_summaries_company_id_idx on public.ai_summaries (company_id);
create index ai_summaries_profile_id_idx on public.ai_summaries (profile_id);
create index ai_summaries_company_period_idx
  on public.ai_summaries (company_id, kind, period_start desc);

-- Append-only. No update or delete policy is granted on this table by design.
create table public.audit_log_entries (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   text not null,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_entries_company_created_idx
  on public.audit_log_entries (company_id, created_at desc);
create index audit_log_entries_actor_id_idx on public.audit_log_entries (actor_id);
