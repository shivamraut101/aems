-- RLS isolation + privilege-escalation suite.
--
-- Run against a database that has every migration applied. The whole thing runs
-- inside a transaction and ends in ROLLBACK, so it leaves no rows behind and is
-- safe to run against a shared dev project.
--
--   supabase db execute --file supabase/tests/rls_isolation.sql
--   -- or paste into the SQL editor
--
-- Every row of the output must read PASS. This suite is not decoration: it has
-- already caught a real privilege-escalation hole (an employee could set their own
-- profiles.monitoring_enabled = false and switch off monitoring, fixed in
-- migration 20260805000005). Re-run it after ANY change to a policy or to the
-- profiles table.
--
-- Why it works: `set local role authenticated` plus a `request.jwt.claims` setting
-- makes auth.uid() resolve to the chosen fixture user, which is exactly what
-- PostgREST does per request. Testing policies any other way tests nothing —
-- as the postgres superuser, RLS is bypassed and every query looks fine.

begin;

create temp table results (test text, expected text, actual text);
grant all on results to authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants, four people
--   Acme   - alice (employee), bob (manager)
--   Globex - carol (super_admin), dave (employee)
-- ---------------------------------------------------------------------------

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-4000-8000-000000000001','authenticated','authenticated','alice@acme.test','x',now(),now(),now()),
  ('00000000-0000-0000-0000-000000000000','bbbbbbbb-0000-4000-8000-000000000002','authenticated','authenticated','bob@acme.test','x',now(),now(),now()),
  ('00000000-0000-0000-0000-000000000000','cccccccc-0000-4000-8000-000000000003','authenticated','authenticated','carol@globex.test','x',now(),now(),now()),
  ('00000000-0000-0000-0000-000000000000','dddddddd-0000-4000-8000-000000000004','authenticated','authenticated','dave@globex.test','x',now(),now(),now());

insert into public.companies (id, name) values
  ('11111111-0000-4000-8000-000000000001','Acme'),
  ('22222222-0000-4000-8000-000000000002','Globex');

insert into public.profiles (id, company_id, email, full_name, role, department) values
  ('aaaaaaaa-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','alice@acme.test','Alice','employee','Engineering'),
  ('bbbbbbbb-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000001','bob@acme.test','Bob','manager','Engineering'),
  ('cccccccc-0000-4000-8000-000000000003','22222222-0000-4000-8000-000000000002','carol@globex.test','Carol','super_admin','Ops'),
  ('dddddddd-0000-4000-8000-000000000004','22222222-0000-4000-8000-000000000002','dave@globex.test','Dave','employee','Sales');

update public.profiles set manager_id = 'bbbbbbbb-0000-4000-8000-000000000002'
  where id = 'aaaaaaaa-0000-4000-8000-000000000001';

insert into public.devices (id, company_id, profile_id, platform, label) values
  ('de000001-0000-4000-8000-000000000011','11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','windows','Alice Laptop'),
  ('de000002-0000-4000-8000-000000000012','22222222-0000-4000-8000-000000000002','dddddddd-0000-4000-8000-000000000004','macos','Dave Laptop');

-- Alice 1 event, Bob 1 event (same tenant), Dave 1 event (other tenant).
-- Bob's row is what proves employee-level isolation *within* a company.
insert into public.activity_events (id, company_id, profile_id, device_id, app_name, started_at, ended_at, client_event_id)
overriding system value values
  (7001,'11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','de000001-0000-4000-8000-000000000011','code.exe', now()-interval '1 hour', now(), gen_random_uuid()),
  (7002,'11111111-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000002','de000001-0000-4000-8000-000000000011','excel.exe', now()-interval '1 hour', now(), gen_random_uuid()),
  (7003,'22222222-0000-4000-8000-000000000002','dddddddd-0000-4000-8000-000000000004','de000002-0000-4000-8000-000000000012','safari', now()-interval '1 hour', now(), gen_random_uuid());

insert into public.device_telemetry (company_id, device_id, battery_level) values
  ('11111111-0000-4000-8000-000000000001','de000001-0000-4000-8000-000000000011',80),
  ('22222222-0000-4000-8000-000000000002','de000002-0000-4000-8000-000000000012',50);

insert into public.device_applications (company_id, device_id, name) values
  ('11111111-0000-4000-8000-000000000001','de000001-0000-4000-8000-000000000011','VS Code'),
  ('22222222-0000-4000-8000-000000000002','de000002-0000-4000-8000-000000000012','Xcode');

insert into public.audit_log_entries (id, company_id, actor_id, action, target_type, target_id)
overriding system value values
  (9001,'11111111-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000002','device.enrolled','device','de000001-0000-4000-8000-000000000011');

-- One rule per tenant. These decide what counts as productive, so write access to
-- them is write access to everyone's numbers: an employee who could edit a rule
-- could recategorise their own day without touching a single activity row.
insert into public.category_rules (id, company_id, priority, category_path, productivity, match_app) values
  ('ca000001-0000-4000-8000-000000000021','11111111-0000-4000-8000-000000000001',10,array['Development'],'productive','code.exe'),
  ('ca000002-0000-4000-8000-000000000022','22222222-0000-4000-8000-000000000002',10,array['Browsing'],'neutral','safari');

-- ---------------------------------------------------------------------------
-- Part 1 - visibility
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
insert into results select 'alice(employee): sees ONLY own activity, not Bob''s', '1', count(*)::text from public.activity_events;
insert into results select 'alice(employee): own device only',          '1', count(*)::text from public.devices;
insert into results select 'alice(employee): own telemetry only',       '1', count(*)::text from public.device_telemetry;
insert into results select 'alice(employee): own device apps only',     '1', count(*)::text from public.device_applications;
insert into results select 'alice(employee): NO audit log',             '0', count(*)::text from public.audit_log_entries;
insert into results select 'alice(employee): own company only',         '1', count(*)::text from public.companies;
-- Counted as "nothing from the other tenant", not as an absolute. Creating a company
-- fires `companies_seed_category_rules`, which grants it 21 starter rules, so any
-- fixed number here breaks the day someone edits that default set.
insert into results select 'alice(employee): NO other-tenant rules',    '0', count(*)::text from public.category_rules where company_id <> '11111111-0000-4000-8000-000000000001';
insert into results select 'alice(employee): CAN see own company rule', 'yes', case when count(*) = 1 then 'yes' else 'no' end from public.category_rules where id = 'ca000001-0000-4000-8000-000000000021';
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
insert into results select 'bob(manager): sees ALL Acme activity',      '2', count(*)::text from public.activity_events;
insert into results select 'bob(manager): NO cross-tenant leak',        '0', count(*)::text from public.activity_events where company_id='22222222-0000-4000-8000-000000000002';
insert into results select 'bob(manager): NO audit log (admin only)',   '0', count(*)::text from public.audit_log_entries;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
insert into results select 'carol(super_admin): only Globex activity',  '1', count(*)::text from public.activity_events;
insert into results select 'carol(super_admin): NO Acme leak',          '0', count(*)::text from public.activity_events where company_id='11111111-0000-4000-8000-000000000001';
insert into results select 'carol(super_admin): NO Acme audit log',     '0', count(*)::text from public.audit_log_entries;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-4000-8000-000000000004","role":"authenticated"}';
insert into results select 'dave(employee): own activity only',         '1', count(*)::text from public.activity_events;
insert into results select 'dave(employee): NO Acme leak',              '0', count(*)::text from public.activity_events where company_id='11111111-0000-4000-8000-000000000001';
reset role;

-- ---------------------------------------------------------------------------
-- Part 2 - write attempts. An RLS violation raises 42501; a statement that
-- simply matches no rows does NOT error, so row_count is checked too. Both
-- signals are needed to tell "blocked" from "matched nothing".
-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  execute 'set local role authenticated';
  execute $q$set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}'$q$;

  begin
    update public.profiles set role='super_admin' where id='aaaaaaaa-0000-4000-8000-000000000001';
    insert into results values ('employee escalates own role', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee escalates own role', 'BLOCKED', 'BLOCKED'); end;

  begin
    update public.profiles set company_id='22222222-0000-4000-8000-000000000002' where id='aaaaaaaa-0000-4000-8000-000000000001';
    insert into results values ('employee hops tenant', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee hops tenant', 'BLOCKED', 'BLOCKED'); end;

  -- regression guard for migration 20260805000005
  begin
    update public.profiles set monitoring_enabled=false where id='aaaaaaaa-0000-4000-8000-000000000001';
    insert into results values ('employee disables own monitoring', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee disables own monitoring', 'BLOCKED', 'BLOCKED'); end;

  begin
    update public.profiles set manager_id=null where id='aaaaaaaa-0000-4000-8000-000000000001';
    insert into results values ('employee detaches own manager', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee detaches own manager', 'BLOCKED', 'BLOCKED'); end;

  begin
    update public.profiles set department='Executive' where id='aaaaaaaa-0000-4000-8000-000000000001';
    insert into results values ('employee changes own department', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee changes own department', 'BLOCKED', 'BLOCKED'); end;

  begin
    insert into public.activity_events (company_id, profile_id, device_id, app_name, started_at, client_event_id)
    values ('11111111-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','de000001-0000-4000-8000-000000000011','forged', now(), gen_random_uuid());
    insert into results values ('employee forges activity row', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee forges activity row', 'BLOCKED', 'BLOCKED'); end;

  -- Categorisation is a scoring lever, not reference data. Insert raises (the
  -- WITH CHECK fails); update matches nothing and returns silently, so both
  -- signals are needed again.
  begin
    insert into public.category_rules (company_id, priority, category_path, productivity, match_app)
    values ('11111111-0000-4000-8000-000000000001',1,array['Development'],'productive','solitaire.exe');
    insert into results values ('employee forges category rule', 'BLOCKED', 'NOT BLOCKED');
  exception when others then insert into results values ('employee forges category rule', 'BLOCKED', 'BLOCKED'); end;

  update public.category_rules set productivity='productive'
    where id='ca000001-0000-4000-8000-000000000021';
  get diagnostics n = row_count;
  insert into results values ('employee rescores own company rule', '0 rows', n || ' rows');

  delete from public.activity_events where id = 7001;
  get diagnostics n = row_count;
  insert into results values ('employee deletes own activity', '0 rows', n || ' rows');

  update public.audit_log_entries set action='tampered' where id = 9001;
  get diagnostics n = row_count;
  insert into results values ('employee tampers audit log', '0 rows', n || ' rows');

  -- legitimate: renaming yourself must still work
  update public.profiles set full_name='Alice Smith' where id='aaaaaaaa-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  insert into results values ('employee renames self (legitimate)', '1 rows', n || ' rows');

  execute 'reset role';
end $$;

-- Category rules are super-admin-only by design, so a manager is the interesting
-- negative case: managers read everyone's activity, which makes it easy to assume
-- they may also tune the rules that score it. They may not.
do $$
declare n int;
begin
  execute 'set local role authenticated';
  execute $q$set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}'$q$;

  update public.category_rules set productivity='unproductive'
    where id='ca000001-0000-4000-8000-000000000021';
  get diagnostics n = row_count;
  insert into results values ('manager rescores company rule', '0 rows', n || ' rows');

  -- Switch identity WITHOUT dropping back to the table owner in between. A bare
  -- `reset role` here would run the next two statements as the superuser, which
  -- bypasses RLS entirely — the tests would pass while proving nothing.
  execute $q$set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}'$q$;

  -- Carol is a super_admin, but of Globex. Role alone must not be the gate.
  update public.category_rules set productivity='unproductive'
    where id='ca000001-0000-4000-8000-000000000021';
  get diagnostics n = row_count;
  insert into results values ('super_admin rescores OTHER tenant rule', '0 rows', n || ' rows');

  -- ...and the legitimate case must still work, or the policy is merely broken.
  update public.category_rules set productivity='productive'
    where id='ca000002-0000-4000-8000-000000000022';
  get diagnostics n = row_count;
  insert into results values ('super_admin rescores OWN rule (legitimate)', '1 rows', n || ' rows');

  execute 'reset role';
end $$;

-- ground truth, read with RLS bypassed, after every attempt above
insert into results select 'GROUND TRUTH: activity row survived',  'yes', case when count(*)=1 then 'yes' else 'NO - DELETED' end from public.activity_events where id=7001;
insert into results select 'GROUND TRUTH: audit entry untampered', 'yes', case when max(action)='device.enrolled' then 'yes' else 'NO - '||max(action) end from public.audit_log_entries where id=9001;
insert into results select 'GROUND TRUTH: monitoring still on',    'yes', case when bool_and(monitoring_enabled) then 'yes' else 'NO - DISABLED' end from public.profiles where id='aaaaaaaa-0000-4000-8000-000000000001';
insert into results select 'GROUND TRUTH: role unchanged',         'employee', max(role) from public.profiles where id='aaaaaaaa-0000-4000-8000-000000000001';
insert into results select 'GROUND TRUTH: Acme rule unrescored',   'productive', max(productivity) from public.category_rules where id='ca000001-0000-4000-8000-000000000021';

select
  test,
  expected,
  actual,
  case when expected = actual then 'PASS' else 'FAIL' end as result
from results;

rollback;
