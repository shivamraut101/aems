-- docs/scope.md §3.5 — Location tracking, for company-owned Android phones.
--
-- §3.5 marks this "only if required by the client", and migration ...0004 deliberately
-- left it out on those grounds. It is in now because the client asked for it by name
-- on 2026-08-07, choosing current location *plus history* and collection while the app
-- is closed. Geofencing, the third item in §3.5, was offered and deferred — there is no
-- zones table here and none is implied by this one.
--
-- This is the most sensitive table in the product. Two consequences are built in rather
-- than left to the read path:
--
--   * There is no company-wide read for non-managers and no anon access at all. An
--     employee sees their own trail and nothing else, which is Non-negotiable #3 applied
--     to the one dataset where getting it wrong follows someone home.
--   * Points are only ever written against a device whose consent is in force. That is
--     enforced in the API (`assertConsent`) on the same path as every other event, so a
--     revoked employee stops producing a trail on the agent's next request.
--
-- Retention is deliberately NOT set here. A location history that is kept forever is a
-- different product from one kept for 30 days, and that is the client's decision to
-- make explicitly rather than one to inherit from a schema written today.

create table public.location_points (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  device_id       uuid not null references public.devices (id) on delete cascade,
  -- Ties a point to the working day it belongs to, so "where was he while clocked in"
  -- is answerable without a timestamp join, and off-shift points stay distinguishable.
  work_session_id bigint references public.work_sessions (id) on delete set null,
  recorded_at     timestamptz not null,
  -- `double precision` rather than numeric: these come from a GPS chip as floats and
  -- the false precision of a decimal type would imply an accuracy that is not there.
  latitude        double precision not null check (latitude >= -90 and latitude <= 90),
  longitude       double precision not null check (longitude >= -180 and longitude <= 180),
  -- Metres of horizontal uncertainty, as Android reports it. Stored because a point
  -- with 2km accuracy and one with 5m accuracy must not be read as the same claim.
  accuracy_m      real check (accuracy_m is null or accuracy_m >= 0),
  -- Agents retry offline batches; this makes ingestion idempotent, exactly as it does
  -- for activity, idle and break events.
  client_event_id uuid not null,
  created_at      timestamptz not null default now()
);

create index location_points_company_id_idx on public.location_points (company_id);
create index location_points_device_recorded_idx
  on public.location_points (device_id, recorded_at desc);
create index location_points_profile_recorded_idx
  on public.location_points (company_id, profile_id, recorded_at desc);
create unique index location_points_client_event_key
  on public.location_points (device_id, client_event_id);

alter table public.location_points enable row level security;

-- The employee's own trail. Same shape as `break_events_select_self`: a direct
-- profile_id match, not a device join, because the row already carries the person.
create policy location_points_select_self on public.location_points
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy location_points_select_company_managers on public.location_points
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

-- No insert/update/delete policy for `authenticated`, matching every other event table:
-- writes arrive through the API on the service-role key, which bypasses RLS. An
-- employee who could insert here could manufacture an alibi; one who could delete could
-- erase where they were. Both are denied by there being no policy at all.
