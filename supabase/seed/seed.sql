-- Local development seed. Applied by `supabase db reset`.
--
-- Creates one company with a baseline monitoring policy. Profiles are NOT seeded
-- here: a profile row references auth.users(id), so users must be created through
-- Supabase Auth first (see scripts/seed-users.md or the Studio UI), then given a
-- profile row pointing at this company.

insert into public.companies (id, name)
values ('00000000-0000-4000-8000-000000000001', 'Acme Corp')
on conflict (id) do nothing;

insert into public.policies (
  company_id,
  version,
  name,
  screenshot_interval_seconds,
  idle_threshold_seconds,
  tracked_categories
)
values (
  '00000000-0000-4000-8000-000000000001',
  '2026.08.1',
  'Standard Monitoring Policy',
  300,
  120,
  array['development', 'communication', 'documentation', 'browsing']
)
on conflict (company_id, version) do nothing;
