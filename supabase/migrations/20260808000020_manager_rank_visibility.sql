-- Managers stop at their own rank.
--
-- `private.is_manager()` answers "is the reader a manager or above", which is the
-- right question for "may this person see colleagues at all" and the wrong one for
-- "may this person see *this* colleague". Every manager-facing select policy was
-- built on it, so a manager could read the super admin's profile, devices, work
-- sessions, activity, idle stretches, breaks, screenshots, reports, AI summaries,
-- consent records, telemetry, installed applications and location history — the whole
-- product, pointed at the owner of the company.
--
-- The rule below is rank-strict: a manager sees ranks *below* their own, so employees
-- and themselves. Not a peer manager, not the super admin. It deliberately does not
-- read `manager_id`: that column is null on most profiles today, so a rule built on it
-- would show a manager an empty dashboard on day one, and a reporting line is an
-- org-chart fact rather than a privilege boundary. Narrowing to a manager's own
-- reports is a second filter that can sit on top of this one later.
--
-- Mirrored in `packages/auth/src/roles.ts` (`canViewRole`) and enforced independently
-- in `apps/api/src/lib/visibility.ts`, because the API holds the service-role key and
-- never sees these policies. Both paths must carry the rule; neither is a backstop for
-- the other.
--
-- **Every policy naming `is_manager` is rewritten here, not just the obvious ones.**
-- RLS policies are OR-ed: a single surviving permissive policy grants the read back
-- and the fix silently does nothing. A first pass at this migration rewrote the names
-- in `…0002` and missed the consolidated `*_select` policies a later migration
-- introduced — the manager's roster correctly hid the super admin while
-- `screenshots_select` still returned 82 of their screenshots.

create or replace function private.can_view_profile(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    -- Non-negotiable #3: everyone reads their own data, whatever their rank.
    target = (select auth.uid())
    or exists (
      select 1
      from public.profiles viewer
      join public.profiles subject on subject.id = target
      where viewer.id = (select auth.uid())
        -- Tenant boundary. Without it a manager in one company could name a profile
        -- id in another and the rank test alone would happily pass them.
        and viewer.company_id = subject.company_id
        and (
          viewer.role = 'super_admin'
          or (viewer.role = 'manager' and subject.role = 'employee')
        )
    );
$$;

-- Device-keyed tables carry no `profile_id`; the owner is one hop away. Separate
-- function rather than an inlined `exists` in six policies, so the join lives once.
create or replace function private.can_view_device(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.devices d
    where d.id = target
      and private.can_view_profile(d.profile_id)
  );
$$;

grant execute on function private.can_view_profile(uuid) to authenticated;
grant execute on function private.can_view_device(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Duplicates from the first pass.
--
-- These names come from `…0002` and were superseded by consolidated `*_select`
-- policies. Recreating them added a second permissive grant beside the live one,
-- which is worse than leaving them dropped: two policies to keep in step, and the
-- looser one always wins.
-- ---------------------------------------------------------------------------

drop policy if exists activity_events_select_company_managers on public.activity_events;
drop policy if exists ai_summaries_select_company_managers on public.ai_summaries;
drop policy if exists consent_records_select_company_managers on public.consent_records;
drop policy if exists idle_events_select_company_managers on public.idle_events;
drop policy if exists reports_select_company_managers on public.reports;
drop policy if exists screenshots_select_company_managers on public.screenshots;
drop policy if exists work_sessions_select_company_managers on public.work_sessions;

-- ---------------------------------------------------------------------------
-- Person-keyed tables. Self is folded into `can_view_profile`, so these no longer
-- need the `profile_id = auth.uid() or …` prefix the consolidated policies carried.
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select_company_managers on public.profiles;
create policy profiles_select_company_managers on public.profiles
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(id))
  );

drop policy if exists devices_select_company_managers on public.devices;
create policy devices_select_company_managers on public.devices
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists location_points_select_company_managers on public.location_points;
create policy location_points_select_company_managers on public.location_points
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists activity_events_select on public.activity_events;
create policy activity_events_select on public.activity_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists idle_events_select on public.idle_events;
create policy idle_events_select on public.idle_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists break_events_select on public.break_events;
create policy break_events_select on public.break_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists work_sessions_select on public.work_sessions;
create policy work_sessions_select on public.work_sessions
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists screenshots_select on public.screenshots;
create policy screenshots_select on public.screenshots
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists consent_records_select on public.consent_records;
create policy consent_records_select on public.consent_records
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists website_block_events_select_company_managers on public.website_block_events;
create policy website_block_events_select_company_managers on public.website_block_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

drop policy if exists device_enrollment_codes_select on public.device_enrollment_codes;
create policy device_enrollment_codes_select on public.device_enrollment_codes
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_profile(profile_id))
  );

-- ---------------------------------------------------------------------------
-- Device-keyed tables — the subject is the device's owner.
-- ---------------------------------------------------------------------------

drop policy if exists device_applications_select on public.device_applications;
create policy device_applications_select on public.device_applications
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_device(device_id))
  );

drop policy if exists device_telemetry_select on public.device_telemetry;
create policy device_telemetry_select on public.device_telemetry
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_device(device_id))
  );

drop policy if exists device_collection_settings_select on public.device_collection_settings;
create policy device_collection_settings_select on public.device_collection_settings
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.can_view_device(device_id))
  );

-- ---------------------------------------------------------------------------
-- Derived output. `profile_id is null` marks a company-wide artefact — a team report,
-- the company AI insight — which `docs/scope.md` §5 and §6 give managers by name. It
-- stays readable: the alternative is a manager losing team reports entirely, and an
-- aggregate is not the owner's personal timeline.
-- ---------------------------------------------------------------------------

drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (
      (profile_id is null and (select private.is_manager()))
      or (select private.can_view_profile(profile_id))
    )
  );

drop policy if exists ai_summaries_select on public.ai_summaries;
create policy ai_summaries_select on public.ai_summaries
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (
      (profile_id is null and (select private.is_manager()))
      or (select private.can_view_profile(profile_id))
    )
  );

comment on function private.can_view_profile(uuid) is
  'Rank-strict visibility: super admins see their company, managers see employees and themselves, everyone sees themselves. Mirrored in packages/auth/src/roles.ts and apps/api/src/lib/visibility.ts.';
