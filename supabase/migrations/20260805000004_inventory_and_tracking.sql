-- Covers the parts of docs/scope.md the initial schema did not reach:
-- device inventory (§7), mobile device activity (§3.3), break time (§2.2),
-- website tracking (§2.5), and the per-employee monitoring toggle (§4.2).
--
-- Deliberately NOT included: location tracking (§3.5). The scope document marks it
-- "only if required by the client", and it is the most sensitive data in the
-- product — it stays out of the schema until someone decides it is in.

-- ---------------------------------------------------------------------------
-- §4.2 Employee management: assign a manager, switch monitoring on and off
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column manager_id uuid references public.profiles (id) on delete set null,
  -- Agents must poll this and stop collecting when it goes false.
  add column monitoring_enabled boolean not null default true;

create index profiles_manager_id_idx on public.profiles (manager_id);

-- ---------------------------------------------------------------------------
-- §7 Device inventory: static hardware facts, captured at enrolment
-- ---------------------------------------------------------------------------

alter table public.devices
  add column device_name text not null default '',
  add column model text,
  add column cpu text,
  add column ram_mb integer check (ram_mb is null or ram_mb > 0),
  add column storage_mb integer check (storage_mb is null or storage_mb > 0);

-- §2.5 Website tracking. The agent supplies the domain rather than the database
-- parsing it out of `url`: the agent already knows which browser tab it read, and
-- URL parsing in SQL gets the edge cases (IDN, ports, userinfo) wrong.
alter table public.activity_events
  add column domain text;

create index activity_events_domain_idx
  on public.activity_events (company_id, domain, started_at desc)
  where domain is not null;

-- ---------------------------------------------------------------------------
-- §2.2 Break time — distinct from idle. Idle is inferred from input silence;
-- a break is something the employee declared.
-- ---------------------------------------------------------------------------

create table public.break_events (
  id               bigint generated always as identity primary key,
  company_id       uuid not null references public.companies (id) on delete cascade,
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  device_id        uuid not null references public.devices (id) on delete cascade,
  work_session_id  bigint references public.work_sessions (id) on delete set null,
  break_start_at   timestamptz not null,
  break_end_at     timestamptz,
  duration_seconds integer generated always as (
    case
      when break_end_at is null then null
      else (extract(epoch from (break_end_at - break_start_at)))::integer
    end
  ) stored,
  client_event_id  uuid not null,
  created_at       timestamptz not null default now(),
  check (break_end_at is null or break_end_at >= break_start_at)
);

create index break_events_company_id_idx on public.break_events (company_id);
create index break_events_device_id_idx on public.break_events (device_id);
create index break_events_profile_start_idx
  on public.break_events (company_id, profile_id, break_start_at desc);
create unique index break_events_client_event_key
  on public.break_events (device_id, client_event_id);

-- ---------------------------------------------------------------------------
-- §3.3 / §7 Mutable device telemetry — battery, network, storage, screen time.
--
-- Separate from `devices` because these change every heartbeat. Writing them onto
-- the device row would rewrite it constantly and destroy the table's cache
-- locality; here they are an append-only series that can be aged out on its own.
-- ---------------------------------------------------------------------------

create table public.device_telemetry (
  id                   bigint generated always as identity primary key,
  company_id           uuid not null references public.companies (id) on delete cascade,
  device_id            uuid not null references public.devices (id) on delete cascade,
  recorded_at          timestamptz not null default now(),
  battery_level        smallint check (battery_level is null or battery_level between 0 and 100),
  battery_charging     boolean,
  network_type         text check (network_type is null or network_type in ('wifi', 'cellular', 'ethernet', 'offline')),
  storage_free_mb      integer check (storage_free_mb is null or storage_free_mb >= 0),
  -- Android: time the screen was on since the previous sample.
  screen_active_seconds integer check (screen_active_seconds is null or screen_active_seconds >= 0)
);

create index device_telemetry_company_id_idx on public.device_telemetry (company_id);
create index device_telemetry_device_recorded_idx
  on public.device_telemetry (device_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- §7 Installed applications, per device
-- ---------------------------------------------------------------------------

create table public.device_applications (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id) on delete cascade,
  device_id    uuid not null references public.devices (id) on delete cascade,
  name         text not null,
  version      text,
  -- Android package name / Windows executable. Null where the platform has no
  -- stable identifier beyond the display name.
  identifier   text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index device_applications_company_id_idx on public.device_applications (company_id);
create unique index device_applications_device_name_key
  on public.device_applications (device_id, name);

-- ---------------------------------------------------------------------------
-- RLS for the new tables — same shape as the activity tables: employees read
-- their own, managers read the company, writes are service_role only.
-- ---------------------------------------------------------------------------

alter table public.break_events        enable row level security;
alter table public.device_telemetry    enable row level security;
alter table public.device_applications enable row level security;

create policy break_events_select_self on public.break_events
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy break_events_select_company_managers on public.break_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

-- Telemetry and inventory hang off a device, not a person, so self-access is
-- expressed as "a device assigned to me".
create policy device_telemetry_select_self on public.device_telemetry
  for select to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_telemetry.device_id
        and d.profile_id = (select auth.uid())
    )
  );

create policy device_telemetry_select_company_managers on public.device_telemetry
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy device_applications_select_self on public.device_applications
  for select to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_applications.device_id
        and d.profile_id = (select auth.uid())
    )
  );

create policy device_applications_select_company_managers on public.device_applications
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );
