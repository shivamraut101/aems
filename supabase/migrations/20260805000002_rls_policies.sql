-- AEMS row level security.
--
-- Access model, enforced in the database rather than in application code:
--
--   super_admin  full read/write across their own company
--   manager      reads every employee's data in their company; no schema/config writes
--   employee     reads only their own rows (transparency is a compliance requirement,
--                not a nicety — people are entitled to see what was recorded about them)
--
-- Ingestion runs through the Fastify API using the service_role key, which bypasses
-- RLS. That is why the event tables below grant no insert/update to `authenticated`:
-- an agent cannot write straight to Postgres, it must go through the API.

-- ---------------------------------------------------------------------------
-- Helpers
--
-- These are security definer so they can read public.profiles without triggering
-- profiles' own RLS policies — a policy on profiles that selects from profiles
-- would recurse forever. They live in `private`, which PostgREST does not expose,
-- so they are unreachable from the client API.
-- ---------------------------------------------------------------------------

create or replace function private.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select company_id from public.profiles where id = (select auth.uid());
$$;

create or replace function private.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid());
$$;

create or replace function private.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and role in ('super_admin', 'manager')
  );
$$;

create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and role = 'super_admin'
  );
$$;

-- Policy expressions are evaluated with the querying role's privileges, so
-- `authenticated` needs EXECUTE for any policy that calls these. Reachability from
-- the client API is already blocked by the schema not being exposed.
grant usage on schema private to authenticated;
grant execute on function private.current_company_id() to authenticated;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.is_manager() to authenticated;
grant execute on function private.is_super_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. A public table without RLS is a data leak.
-- ---------------------------------------------------------------------------

alter table public.companies         enable row level security;
alter table public.profiles          enable row level security;
alter table public.policies          enable row level security;
alter table public.devices           enable row level security;
alter table public.consent_records   enable row level security;
alter table public.work_sessions     enable row level security;
alter table public.activity_events   enable row level security;
alter table public.idle_events       enable row level security;
alter table public.screenshots       enable row level security;
alter table public.reports           enable row level security;
alter table public.ai_summaries      enable row level security;
alter table public.audit_log_entries enable row level security;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------

create policy companies_select_own on public.companies
  for select to authenticated
  using (id = (select private.current_company_id()));

create policy companies_update_super_admin on public.companies
  for update to authenticated
  using (id = (select private.current_company_id()) and (select private.is_super_admin()))
  with check (id = (select private.current_company_id()));

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_company_managers on public.profiles
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  -- Stops a user promoting themselves or moving companies; both columns must
  -- match what is already stored.
  with check (
    id = (select auth.uid())
    and role = (select private.current_app_role())
    and company_id = (select private.current_company_id())
  );

create policy profiles_write_super_admin on public.profiles
  for all to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  )
  with check (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  );

-- ---------------------------------------------------------------------------
-- policies — everyone in the company may read the monitoring rules that apply
-- to them; only super admins may change them.
-- ---------------------------------------------------------------------------

create policy policies_select_company on public.policies
  for select to authenticated
  using (company_id = (select private.current_company_id()));

create policy policies_write_super_admin on public.policies
  for all to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  )
  with check (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  );

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

create policy devices_select_self on public.devices
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy devices_select_company_managers on public.devices
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy devices_write_super_admin on public.devices
  for all to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  )
  with check (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  );

-- ---------------------------------------------------------------------------
-- consent_records — readable by the person who gave consent and by managers.
-- No update or delete policy: consent history is append-only, and revoking is a
-- service-role operation that stamps revoked_at.
-- ---------------------------------------------------------------------------

create policy consent_records_select_self on public.consent_records
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy consent_records_select_company_managers on public.consent_records
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy consent_records_insert_self on public.consent_records
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and company_id = (select private.current_company_id())
  );

-- ---------------------------------------------------------------------------
-- Activity data — read-only for authenticated clients. Writes are service_role.
-- ---------------------------------------------------------------------------

create policy work_sessions_select_self on public.work_sessions
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy work_sessions_select_company_managers on public.work_sessions
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy activity_events_select_self on public.activity_events
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy activity_events_select_company_managers on public.activity_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy idle_events_select_self on public.idle_events
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy idle_events_select_company_managers on public.idle_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy screenshots_select_self on public.screenshots
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy screenshots_select_company_managers on public.screenshots
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

-- ---------------------------------------------------------------------------
-- Derived output
-- ---------------------------------------------------------------------------

create policy reports_select_self on public.reports
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy reports_select_company_managers on public.reports
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

create policy ai_summaries_select_self on public.ai_summaries
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy ai_summaries_select_company_managers on public.ai_summaries
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

-- ---------------------------------------------------------------------------
-- audit_log_entries — super admins read; nobody but service_role writes, and
-- nothing may ever update or delete a row.
-- ---------------------------------------------------------------------------

create policy audit_log_select_super_admin on public.audit_log_entries
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  );
