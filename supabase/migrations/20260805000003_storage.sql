-- AEMS storage.
--
-- One private bucket, laid out per the stack document:
--
--   {company_id}/{profile_id}/screenshots/{captured_at}-{uuid}.webp
--   {company_id}/{profile_id}/reports/{period}-{uuid}.pdf
--
-- The leading two path segments are what the policies below authorise against, so
-- the layout is load-bearing — changing it changes who can read what.
--
-- Uploads are service_role only: agents post binaries to the Fastify API, which
-- validates and writes them. There is deliberately no insert policy for
-- `authenticated`, so a stolen anon key cannot plant objects.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'aems',
  'aems',
  false,
  10485760, -- 10 MiB
  array['image/webp', 'image/png', 'image/jpeg', 'application/pdf', 'text/csv']
)
on conflict (id) do nothing;

-- Employees can read their own captures.
create policy aems_storage_select_self on storage.objects
  for select to authenticated
  using (
    bucket_id = 'aems'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- Managers and super admins can read anything belonging to their company.
create policy aems_storage_select_company_managers on storage.objects
  for select to authenticated
  using (
    bucket_id = 'aems'
    and (storage.foldername(name))[1] = (select private.current_company_id())::text
    and (select private.is_manager())
  );
