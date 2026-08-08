-- Per-device collection scope: which data types a given machine may collect.
--
-- THE SHAPE IS A DENY LIST, AND THAT IS THE WHOLE DESIGN DECISION.
--
-- An allow list would have to be complete at the moment an enrolment code is minted —
-- but the code does not know what kind of machine will redeem it (`POST /api/devices`
-- accepts windows, macos and android on the same route). A code minted by an admin who
-- only had desktop in mind would then arrive at an Android phone as "collect nothing but
-- the four types the dialog listed", and a vocabulary added later would be denied on
-- every device already in the field. A deny list degrades the other way: unknown
-- platform, unknown future type, no row → permitted, which is what "an absent policy
-- means everything the platform supports" requires.
--
-- It is also why this migration needs no backfill and changes no behaviour on deploy.
-- Zero rows exist, so every enrolled device — including every Android device, which is
-- off limits for this work — keeps collecting precisely what it collects today.
--
-- Effective permitted set, computed in packages/types/src/collection.ts:
--
--     PLATFORM_DATA_TYPES[device.platform]        -- what the platform can do
--       minus rows here with enabled = false      -- what an admin switched off
--       intersect consent_records.granted_types   -- what the employee agreed to
--
-- Three sets, intersected. Most restrictive wins, in every direction. That is also the
-- answer to "company says screenshots on, device says off": the company policy carries
-- no per-type switch at all — it sets the screenshot INTERVAL and the idle THRESHOLD,
-- how and not whether — so there is nothing to conflict with. If a company-level
-- default is ever added it joins the intersection as a fourth set and cannot widen a
-- device.

create table if not exists public.device_collection_settings (
  -- Carried rather than joined for RLS: every business table has company_id, and the
  -- API holds the service-role key, so the tenant filter has to be on the row itself.
  company_id uuid not null references public.companies (id) on delete cascade,
  device_id  uuid not null references public.devices (id) on delete cascade,

  data_type  text not null
             check (data_type in (
               'applications', 'websites', 'screenshots',
               'idle', 'telemetry', 'installed_apps', 'location'
             )),

  -- A row exists only once somebody has made a decision about this pair. Re-enabling
  -- does NOT delete the row: "Sam turned screenshots back on on 9 Aug" is a fact the
  -- compliance surfaces have to be able to state, and a deleted row states nothing.
  enabled    boolean not null,

  -- The attribution the dashboard renders. Denormalised here on purpose: the audit log
  -- is the obvious home and is unusable for it — nothing in the product selects from
  -- audit_log_entries, and its only RLS policy is audit_log_select_super_admin
  -- (20260805000002_rls_policies.sql:295), so a manager reading /people/:id could not
  -- see the attribution even with a read endpoint. Per-pair rather than per-device
  -- because two admins changing two types on two days must not both read as the later
  -- one.
  --
  -- Nullable, on delete set null: the person who made the change may leave the company,
  -- and losing the row would lose the decision along with them.
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now(),

  primary key (device_id, data_type)
);

comment on table public.device_collection_settings is
  'Per-device exceptions to the platform default collection scope. A missing row means the type is permitted — absence is the default, so no device changes behaviour when this table is empty.';

create index if not exists device_collection_settings_company_idx
  on public.device_collection_settings (company_id);

alter table public.device_collection_settings enable row level security;

-- Read: managers see their company's, an employee sees their own devices'.
-- Non-negotiable #3 — an employee has to be able to read what is being collected about
-- them without asking anyone.
create policy device_collection_settings_select on public.device_collection_settings
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (
      (select private.is_manager())
      or exists (
        select 1 from public.devices d
        where d.id = device_collection_settings.device_id
          and d.profile_id = (select auth.uid())
      )
    )
  );

-- No insert, update or delete policy for authenticated roles, deliberately and for the
-- same reason as device_enrollment_codes (20260805000012:68-74): narrowing or widening
-- what a machine collects is a decision that goes through the API, which checks the role
-- and writes the attribution. PostgREST is not the place for it.

-- ---------------------------------------------------------------------------
-- The choice made at mint time.
-- ---------------------------------------------------------------------------
--
-- Stored on the code, not sent by the redeeming agent: POST /enroll-with-code is
-- deliberately unauthenticated, so nothing the agent says about its own scope can be
-- trusted. The redemption handler reads this column off the row it already looked up by
-- hash and expands it into the table above.
alter table public.device_enrollment_codes
  add column if not exists denied_types text[] not null default '{}';

-- The API writes this straight from a request body, so it is a trust boundary.
alter table public.device_enrollment_codes
  drop constraint if exists device_enrollment_codes_denied_types_known;

alter table public.device_enrollment_codes
  add constraint device_enrollment_codes_denied_types_known
  check (denied_types <@ array[
    'applications', 'websites', 'screenshots',
    'idle', 'telemetry', 'installed_apps', 'location'
  ]::text[]);

-- ---------------------------------------------------------------------------
-- What was actually agreed to.
-- ---------------------------------------------------------------------------
--
-- consent_records carries policy_version and nothing else today
-- (20260805000001_init_schema.sql:122-133), so the audit trail cannot answer "what did
-- this person agree to on 8 Aug" — and the entire compliance case for per-type
-- collection rests on being able to answer that.
--
-- NULL, not '{}', for the rows that already exist. Null means "the platform default in
-- force when this was signed", which is exactly what those rows mean today; '{}' would
-- mean "agreed to nothing" and would stop every live device collecting the moment this
-- deploys.
alter table public.consent_records
  add column if not exists granted_types text[];

alter table public.consent_records
  drop constraint if exists consent_records_granted_types_known;

alter table public.consent_records
  add constraint consent_records_granted_types_known
  check (granted_types is null or granted_types <@ array[
    'applications', 'websites', 'screenshots',
    'idle', 'telemetry', 'installed_apps', 'location'
  ]::text[]);

comment on column public.consent_records.granted_types is
  'The data types this consent covers. NULL on rows written before per-type consent existed, meaning the platform default of the day. Narrowing the device scope does not invalidate consent; widening it beyond this set does, because the added type was never agreed to.';
