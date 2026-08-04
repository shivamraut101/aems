-- Performance corrections found by the Supabase advisors after applying 0001-0005.
--
-- 1. Unindexed foreign keys.
--    The event tables carry composite indexes like (company_id, profile_id,
--    started_at), which do NOT cover a lookup on profile_id alone — it is not the
--    leftmost column. Postgres does not auto-index foreign keys, so every
--    `on delete cascade` from profiles had to sequentially scan the largest tables
--    in the schema. Offboarding one employee would scan every activity row in the
--    company.
--
-- 2. Duplicate permissive policies.
--    Each event table had a `_select_self` and a `_select_company_managers`
--    policy. Permissive policies are OR'd, so both were evaluated on every read of
--    the highest-volume tables to reach a result either one could have produced.
--    Collapsing them into a single OR'd policy halves policy evaluation per row
--    without changing who can see what — the isolation suite is re-run after this
--    migration to prove that.
--
-- Deliberately NOT changed: profiles, devices and policies keep their separate
-- policies because a `for all` super-admin policy overlaps the select ones there;
-- merging those would tangle read and write rules on the tables where getting it
-- wrong is most costly. They are also low-volume.
--
-- The advisors also report every index as "unused". That is expected on a database
-- with no query history yet, not a signal to drop anything.

-- ---------------------------------------------------------------------------
-- 1. Cover the foreign keys
-- ---------------------------------------------------------------------------

create index if not exists work_sessions_profile_id_idx    on public.work_sessions (profile_id);
create index if not exists activity_events_profile_id_idx  on public.activity_events (profile_id);
create index if not exists idle_events_profile_id_idx      on public.idle_events (profile_id);
create index if not exists screenshots_profile_id_idx      on public.screenshots (profile_id);
create index if not exists break_events_profile_id_idx     on public.break_events (profile_id);
create index if not exists break_events_work_session_id_idx on public.break_events (work_session_id);

-- ---------------------------------------------------------------------------
-- 2. Collapse the select policy pairs
-- ---------------------------------------------------------------------------

-- Employees read their own rows; managers and super admins read their whole
-- company. Identical semantics to the two policies this replaces.
do $$
declare
  t text;
begin
  foreach t in array array[
    'work_sessions', 'activity_events', 'idle_events', 'screenshots',
    'break_events', 'reports', 'ai_summaries', 'consent_records'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_self', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_company_managers', t);
    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (
          profile_id = (select auth.uid())
          or (
            company_id = (select private.current_company_id())
            and (select private.is_manager())
          )
        )
    $f$, t || '_select', t);
  end loop;
end $$;

-- The two device-scoped tables have no profile_id of their own, so "mine" means
-- "attached to a device assigned to me".
drop policy if exists device_telemetry_select_self on public.device_telemetry;
drop policy if exists device_telemetry_select_company_managers on public.device_telemetry;

create policy device_telemetry_select on public.device_telemetry
  for select to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_telemetry.device_id
        and d.profile_id = (select auth.uid())
    )
    or (
      company_id = (select private.current_company_id())
      and (select private.is_manager())
    )
  );

drop policy if exists device_applications_select_self on public.device_applications;
drop policy if exists device_applications_select_company_managers on public.device_applications;

create policy device_applications_select on public.device_applications
  for select to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.id = device_applications.device_id
        and d.profile_id = (select auth.uid())
    )
    or (
      company_id = (select private.current_company_id())
      and (select private.is_manager())
    )
  );
