-- Close a privilege-escalation hole in profiles_update_self.
--
-- Found by the RLS test suite (docs: supabase/tests/): an employee could run
--
--   update profiles set monitoring_enabled = false where id = auth.uid();
--
-- straight against PostgREST with nothing but their own session and the public
-- anon key, and it succeeded. Same for manager_id. That is a self-service opt-out
-- of monitoring — it defeats the product and breaks the compliance model, because
-- the agent and API both gate collection on profiles.monitoring_enabled.
--
-- Cause: the original policy (migration ...0002) pinned only `role` and
-- `company_id` in its WITH CHECK. Migration ...0004 then added
-- `monitoring_enabled` and `manager_id` without widening that policy, so the new
-- columns were self-editable by default.
--
-- Fix: enumerate the admin-controlled fields in ONE security-definer predicate
-- rather than repeating comparisons inline. Adding a new admin-controlled column
-- now means editing a single function instead of remembering to touch a policy —
-- which is the mistake this migration exists to correct.

create or replace function private.profile_admin_fields_unchanged(
  new_role               text,
  new_company_id         uuid,
  new_monitoring_enabled boolean,
  new_manager_id         uuid,
  new_department         text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role               = new_role
      and p.company_id         = new_company_id
      and p.monitoring_enabled = new_monitoring_enabled
      -- `is not distinct from` because both are nullable; `=` yields NULL on a
      -- NULL side, which reads as "not permitted" and would block a legitimate
      -- name change on any employee with no manager or department set.
      and p.manager_id  is not distinct from new_manager_id
      and p.department  is not distinct from new_department
  );
$$;

grant execute on function private.profile_admin_fields_unchanged(text, uuid, boolean, uuid, text) to authenticated;

drop policy if exists profiles_update_self on public.profiles;

-- Employees may edit their own display name and nothing else. Everything an
-- administrator assigns — role, company, monitoring switch, manager, department —
-- must survive the update untouched.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (select private.profile_admin_fields_unchanged(
      role, company_id, monitoring_enabled, manager_id, department
    ))
  );
