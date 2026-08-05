-- Off-boarding without destroying the record of lawful collection.
--
-- Removing an employee cannot be a DELETE. `public.profiles.id` references
-- `auth.users (id) on delete cascade`, and every monitoring table cascades from
-- profiles in turn — so deleting the auth user erases the work sessions, the
-- activity, the screenshot metadata AND the consent_records that prove the
-- collection was consented to in the first place. The screenshot *blobs* in
-- Storage are not cascaded and would survive, leaving the exact inversion a
-- monitoring product must never ship: the images outlive the evidence that
-- taking them was lawful. `deactivated_at` is therefore a tombstone, not a
-- delete, and the audit log stays append-only because nothing is removed.
--
-- Deactivation is enforced in three places, all of which read this column:
--   * `requireUser` in the API rejects the session,
--   * the roster and the headcount KPI exclude the row,
--   * the agent stops because deactivation also forces monitoring_enabled = false,
--     revokes the person's devices and revokes their live consent records.

alter table public.profiles
  add column if not exists deactivated_at timestamptz;

comment on column public.profiles.deactivated_at is
  'Set when an admin off-boards this person. Non-null means: no sign-in, no collection, hidden from the roster. Never hard-delete a profile — the cascade would take the consent records with it.';

-- The roster, the live board and the headcount KPI all filter on
-- (company_id, deactivated_at is null). A partial index keeps that the common,
-- cheap path and stays small because deactivations are rare.
create index if not exists profiles_company_active_idx
  on public.profiles (company_id)
  where deactivated_at is null;

-- ---------------------------------------------------------------------------
-- Widen the self-update guard to cover the new column.
--
-- Migration ...0005 exists because ...0004 added `monitoring_enabled` and
-- `manager_id` without widening `profiles_update_self`, and the new columns were
-- self-editable by default. Adding `deactivated_at` and stopping there would
-- reproduce that bug precisely — and worse: a departed employee holding nothing
-- but their own session and the public anon key could run
--
--   update profiles set deactivated_at = null where id = auth.uid();
--
-- straight against PostgREST and un-fire their own off-boarding.
--
-- The policy depends on the function, so the order is drop policy → drop
-- function → recreate both. `create or replace` with a new argument list would
-- add a SIXTH overload and leave the old five-argument function callable, which
-- is the same trap one signature further along.
-- ---------------------------------------------------------------------------

drop policy if exists profiles_update_self on public.profiles;
drop function if exists private.profile_admin_fields_unchanged(text, uuid, boolean, uuid, text);

create function private.profile_admin_fields_unchanged(
  new_role               text,
  new_company_id         uuid,
  new_monitoring_enabled boolean,
  new_manager_id         uuid,
  new_department         text,
  new_deactivated_at     timestamptz
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
      -- `is not distinct from` because all three are nullable; `=` yields NULL on
      -- a NULL side, which reads as "not permitted" and would block a legitimate
      -- name change by anyone with no manager, no department, and — the normal
      -- case — no deactivation.
      and p.manager_id     is not distinct from new_manager_id
      and p.department     is not distinct from new_department
      and p.deactivated_at is not distinct from new_deactivated_at
  );
$$;

grant execute on function private.profile_admin_fields_unchanged(text, uuid, boolean, uuid, text, timestamptz) to authenticated;

-- Employees may edit their own display name and nothing else. Everything an
-- administrator assigns — role, company, monitoring switch, manager, department,
-- and now the off-boarding tombstone — must survive the update untouched.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and (select private.profile_admin_fields_unchanged(
      role, company_id, monitoring_enabled, manager_id, department, deactivated_at
    ))
  );
