-- Demo data for local testing.
--
-- `seed.sql` runs automatically on `supabase db reset` against a LOCAL stack and
-- creates only a company and a policy — it cannot create people, because
-- `public.profiles.id` references `auth.users(id)` and a user has to exist first.
-- This file creates that whole chain so the dashboard has something to render.
--
-- Run it against the hosted project through the SQL editor, or:
--   supabase db execute --file supabase/seed/demo.sql
--
-- Accounts (all three share the password `aems-demo-2026`):
--   admin@aems.local     Ada Admin       super_admin
--   manager@aems.local   Marcus Manager  manager
--   employee@aems.local  Evan Employee   employee   (has the device and the data)
--
-- Signing in as each is the fastest way to check RLS from the outside: the
-- employee must see only their own rows, the manager the whole company, and the
-- audit log must be visible to neither.
--
-- Re-runnable. Every insert is guarded, and the fixed UUIDs make cleanup one
-- statement — see the bottom of this file.

do $$
declare
  co  uuid := 'c0000000-0000-4000-8000-000000000001';
  adm uuid := 'a0000000-0000-4000-8000-000000000001';
  mgr uuid := 'a0000000-0000-4000-8000-000000000002';
  emp uuid := 'a0000000-0000-4000-8000-000000000003';
  dev uuid := 'd0000000-0000-4000-8000-000000000001';
  ws  bigint;
  day_start timestamptz := date_trunc('day', now());
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  select
    '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
    u.email, extensions.crypt('aems-demo-2026', extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    -- GoTrue reads these as text, not null, on some paths.
    '', '', '', ''
  from (values (adm,'admin@aems.local'), (mgr,'manager@aems.local'), (emp,'employee@aems.local')) as u(id, email)
  on conflict (id) do nothing;

  -- Password sign-in resolves through auth.identities, not auth.users alone.
  -- Without this row the account exists and the login silently fails.
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), u.id,
         jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
         'email', u.id::text, now(), now(), now()
  from (values (adm,'admin@aems.local'), (mgr,'manager@aems.local'), (emp,'employee@aems.local')) as u(id, email)
  on conflict do nothing;

  insert into public.companies (id, name) values (co, 'Acme Corp') on conflict (id) do nothing;

  insert into public.policies (company_id, version, name, screenshot_interval_seconds, idle_threshold_seconds, max_open_break_seconds, tracked_categories)
  values (co, '2026.08.1', 'Standard Monitoring Policy', 300, 120, 10800,
          array['development','communication','documentation','browsing'])
  on conflict (company_id, version) do nothing;

  insert into public.profiles (id, company_id, email, full_name, role, department) values
    (adm, co, 'admin@aems.local',    'Ada Admin',      'super_admin', 'Operations'),
    (mgr, co, 'manager@aems.local',  'Marcus Manager', 'manager',     'Engineering'),
    (emp, co, 'employee@aems.local', 'Evan Employee',  'employee',    'Engineering')
  on conflict (id) do nothing;

  update public.profiles set manager_id = mgr where id = emp;

  insert into public.devices (id, company_id, profile_id, platform, label, device_name, os_version, agent_version, cpu, ram_mb, last_seen_at)
  values (dev, co, emp, 'windows', 'Evan Laptop', 'EVAN-WIN11', '11 (26200)', '0.1.0', 'Intel Core i7-1265U', 16384, now())
  on conflict (id) do nothing;

  -- Without a non-revoked consent row the API refuses ingestion (non-negotiable #1),
  -- so a device seeded without one looks broken rather than unconsented.
  insert into public.consent_records (company_id, profile_id, device_id, policy_version, method)
  values (co, emp, dev, '2026.08.1', 'in_app_dialog')
  on conflict do nothing;

  -- Only seed a day's activity once, or re-running stacks duplicate mornings.
  if exists (select 1 from public.work_sessions where device_id = dev and clock_in_at >= day_start) then
    return;
  end if;

  insert into public.work_sessions (company_id, profile_id, device_id, clock_in_at)
  values (co, emp, dev, day_start + interval '9 hours')
  returning id into ws;

  insert into public.activity_events (company_id, profile_id, device_id, work_session_id, app_name, window_title, domain, category, started_at, ended_at, client_event_id)
  values
    (co, emp, dev, ws, 'Code.exe',   'collector.ts - aems',   null,                'development',   day_start + interval '9 hours',         day_start + interval '10 hours 15 min', gen_random_uuid()),
    (co, emp, dev, ws, 'chrome.exe', 'Supabase Docs',         'supabase.com',      'documentation', day_start + interval '10 hours 15 min', day_start + interval '10 hours 50 min', gen_random_uuid()),
    (co, emp, dev, ws, 'slack.exe',  'Slack | engineering',   null,                'communication', day_start + interval '10 hours 50 min', day_start + interval '11 hours 20 min', gen_random_uuid()),
    (co, emp, dev, ws, 'chrome.exe', 'Stack Overflow',        'stackoverflow.com', 'browsing',      day_start + interval '11 hours 20 min', day_start + interval '11 hours 45 min', gen_random_uuid()),
    (co, emp, dev, ws, 'Code.exe',   'analytics/timeline.ts', null,                'development',   day_start + interval '11 hours 45 min', day_start + interval '13 hours',        gen_random_uuid());

  insert into public.idle_events (company_id, profile_id, device_id, idle_start_at, idle_end_at, client_event_id)
  values (co, emp, dev, day_start + interval '10 hours 55 min', day_start + interval '11 hours 10 min', gen_random_uuid());

  insert into public.break_events (company_id, profile_id, device_id, work_session_id, break_start_at, break_end_at, client_event_id)
  values (co, emp, dev, ws, day_start + interval '13 hours', day_start + interval '13 hours 40 min', gen_random_uuid());

  insert into public.device_telemetry (company_id, device_id, battery_level, battery_charging, network_type)
  values (co, dev, 78, false, 'wifi');

  insert into public.device_applications (company_id, device_id, name, version)
  values (co, dev, 'Visual Studio Code', '1.99.0'), (co, dev, 'Google Chrome', '141.0'), (co, dev, 'Slack', '4.42.0')
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- Cleanup. Deleting the company cascades to every business row; deleting the
-- auth users cascades to their profiles.
--
--   delete from public.companies where id = 'c0000000-0000-4000-8000-000000000001';
--   delete from auth.users where email like '%@aems.local';
-- ---------------------------------------------------------------------------
