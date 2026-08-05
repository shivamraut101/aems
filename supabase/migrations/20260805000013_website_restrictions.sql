-- Website restriction — the rules a managed browser extension enforces, and the
-- record of what those rules stopped.
--
-- SCOPE NOTE. `docs/scope.md` §8 files control features under *Later — not part of
-- MVP*. The client asked for website restriction **by name** on 2026-08-05 and the
-- override is recorded in CLAUDE.md under "Scope decisions taken after the documents
-- were locked". It covers this feature and nothing else in §8: no remote control, no
-- USB control, no file monitoring, no MDM, no endpoint protection.
--
-- Three tables, because they answer three different questions and are written at three
-- very different rates:
--
--   website_restriction_settings   one row per company — is enforcement on at all, and
--                                  is the company running a block-list or an allow-list
--   website_restriction_rules      the ordered rules themselves
--   website_block_events           what was actually stopped, and by which rule
--
-- The third is not optional. A block nobody can see is not auditable, and
-- `docs/design.md` is explicit that an employee must be able to find out which policy
-- stopped a page and who to ask about it. That is only possible if the block was
-- written down at the time it happened.

-- ---------------------------------------------------------------------------
-- Settings — one row per company
--
-- Separate from `policies` on purpose. `policies` is append-only and versioned because
-- consent is recorded against a policy version; restriction settings are edited in
-- place and must take effect on every browser within a polling interval. Folding them
-- into `policies` would either make every proxy-rule tweak mint a version that every
-- employee has to re-consent to, or quietly break the guarantee that a consent record
-- points at unchanging terms.
-- ---------------------------------------------------------------------------

create table public.website_restriction_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,

  -- Off until a super admin turns it on. A monitoring product that starts blocking
  -- pages the moment it is installed is exactly the surveillance framing
  -- `docs/design.md` rules out.
  enabled    boolean not null default false,

  -- What happens to a URL no rule claims.
  --   blocklist  — allowed (the default posture: name what is forbidden)
  --   allowlist  — blocked (a locked-down kiosk posture: name what is permitted)
  mode       text not null default 'blocklist'
             check (mode in ('blocklist', 'allowlist')),

  -- Shown on the block page. This is the "who do I ask about this" line; the design
  -- direction rules out a bare "blocked" screen, and there is nowhere else for a
  -- company to put that sentence.
  notice     text check (notice is null or length(notice) between 1 and 500),

  -- Bumped by the triggers below on ANY settings or rule change. The agent and the
  -- extension poll `GET /api/restrictions/enforcement` and compare this number, which
  -- is how a rule written at 10:02 reaches every browser without a re-enrolment.
  -- Policy currently only reaches an agent AT enrolment; repeating that here would
  -- make every restriction change silently ineffective on already-enrolled machines.
  revision   bigint not null default 1,

  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

create table public.website_restriction_rules (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,

  -- Lower runs first and the first match wins — the same ordering `category_rules`
  -- uses, and for the same reason: an ordered list is what an admin can defend to an
  -- employee ("rule 30 stopped it"), which a most-specific-wins scheme is not.
  priority    integer not null default 100 check (priority >= 0),

  -- Both actions exist in both modes, and that is the whole point of having an action
  -- column rather than inferring it from `mode`. In blocklist mode an `allow` rule is
  -- the carve-out ("block *.example.com, but allow docs.example.com"); in allowlist
  -- mode a `block` rule is the carve-out. Without it, an admin who wants one exception
  -- has to abandon the mode entirely.
  action      text not null check (action in ('block', 'allow')),

  -- `domain`      — a hostname, matched as a SUFFIX at a label boundary. `example.com`
  --                 claims `example.com` and `app.example.com` and never
  --                 `notexample.com`. Ports, paths and query strings are ignored.
  -- `url_pattern` — `[scheme://]host[:port][/path]` with `*` as the only wildcard,
  --                 matched against the whole URL. See the matcher in
  --                 apps/api/src/routes/restrictions.ts, which is the authority on the
  --                 semantics and is tested against every edge this comment names.
  match_kind  text not null check (match_kind in ('domain', 'url_pattern')),

  pattern     text not null check (length(btrim(pattern)) between 1 and 400),

  -- Why the rule exists. Surfaced on the block page next to the notice, because
  -- "blocked by rule 30" tells an employee nothing.
  note        text check (note is null or length(note) between 1 and 300),

  -- Kept rather than deleted, so an admin can switch a rule off during an incident
  -- and back on afterwards without losing its wording or its history.
  enabled     boolean not null default true,

  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- The same pattern twice with two different actions is a coin toss decided by id
  -- ordering. Refuse it here rather than letting an admin debug it at runtime.
  constraint website_restriction_rules_unique_pattern
    unique (company_id, match_kind, pattern)
);

-- Evaluation order is (priority, id): the index serves the agent's fetch directly.
create index website_restriction_rules_company_priority_idx
  on public.website_restriction_rules (company_id, priority, id);

-- ---------------------------------------------------------------------------
-- Block events
--
-- Append-only in practice: the API only ever inserts, and no update or delete policy
-- is granted to `authenticated`.
-- ---------------------------------------------------------------------------

create table public.website_block_events (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies (id) on delete cascade,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  device_id       uuid not null references public.devices (id) on delete cascade,

  -- `on delete set null`, deliberately not a cascade. Deleting a rule must not erase
  -- the record of what it stopped while it existed — that would let a company retract
  -- the evidence of its own enforcement, which is the opposite of auditable.
  rule_id         uuid references public.website_restriction_rules (id) on delete set null,

  -- Snapshot of the rule's pattern and the company's mode as of the moment of the
  -- block, so the row stays readable after the rule is edited, disabled or removed.
  -- Written by the server from the rule row, never taken from the agent: an agent is a
  -- binary on someone's laptop and must not be able to author audit text.
  matched_pattern text check (matched_pattern is null or length(matched_pattern) <= 400),
  mode            text not null check (mode in ('blocklist', 'allowlist')),

  domain          text not null check (length(domain) between 1 and 253),

  -- Scheme, host, optional port and path. **The query string is deliberately dropped
  -- before storage** — a query carries session tokens, search terms and one-time links,
  -- and retaining them turns an enforcement log into a credential store. What was
  -- stopped is answered by scheme+host+path; why it was stopped is answered by
  -- `matched_pattern`.
  url             text not null check (length(url) between 1 and 2048),

  blocked_at      timestamptz not null,

  -- Agents buffer while offline and replay on reconnect; this makes ingestion
  -- idempotent, exactly as it does on activity_events.
  client_event_id uuid not null,
  created_at      timestamptz not null default now()
);

create index website_block_events_company_time_idx
  on public.website_block_events (company_id, blocked_at desc);
create index website_block_events_profile_time_idx
  on public.website_block_events (company_id, profile_id, blocked_at desc);
create index website_block_events_domain_idx
  on public.website_block_events (company_id, domain);
create unique index website_block_events_client_event_key
  on public.website_block_events (device_id, client_event_id);

-- ---------------------------------------------------------------------------
-- Revision bumping
--
-- One counter, on the settings row, moved by any change to the settings OR to any
-- rule. The extension polls one small endpoint and compares one number.
-- ---------------------------------------------------------------------------

create or replace function private.bump_restriction_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  -- BEFORE UPDATE on the settings row itself: no recursion, we are only rewriting
  -- the row already being written.
  new.revision = old.revision + 1;
  return new;
end;
$$;

create trigger website_restriction_settings_bump
  before update on public.website_restriction_settings
  for each row execute function private.bump_restriction_revision();

-- A rule change has to move the same counter, or an extension polling the revision
-- would never learn that a rule was added. SECURITY DEFINER so the bump cannot be
-- refused by RLS on the settings table for whoever happened to write the rule.
create or replace function private.touch_restriction_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := coalesce(new.company_id, old.company_id);
begin
  insert into public.website_restriction_settings (company_id)
  values (target)
  on conflict (company_id) do update set updated_at = now();

  return coalesce(new, old);
end;
$$;

create trigger website_restriction_rules_touch_settings
  after insert or update or delete on public.website_restriction_rules
  for each row execute function private.touch_restriction_settings();

create trigger website_restriction_rules_set_updated_at
  before update on public.website_restriction_rules
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
--
-- All three roles are named on every table, as CLAUDE.md requires. `is_manager()` is
-- true for super admins too, so a manager policy covers both privileged roles; where
-- a super admin needs MORE than a manager it gets its own policy.
-- ---------------------------------------------------------------------------

alter table public.website_restriction_settings enable row level security;
alter table public.website_restriction_rules    enable row level security;
alter table public.website_block_events         enable row level security;

-- Settings: the whole company reads. An employee is entitled to know whether their
-- browsing is being filtered and under which posture — a filter you cannot see the
-- terms of is the surveillance framing `docs/design.md` rules out.
create policy website_restriction_settings_select_company on public.website_restriction_settings
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- Only super admins write. A manager who could edit the rule set could block a site
-- and then present the resulting report, which destroys the record's evidentiary value.
create policy website_restriction_settings_write_super_admin on public.website_restriction_settings
  for all to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  )
  with check (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  );

create policy website_restriction_rules_select_company on public.website_restriction_rules
  for select to authenticated
  using (company_id = (select private.current_company_id()));

create policy website_restriction_rules_write_super_admin on public.website_restriction_rules
  for all to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  )
  with check (
    company_id = (select private.current_company_id())
    and (select private.is_super_admin())
  );

-- Block events: the same shape as every other observation table. The person it was
-- recorded about reads their own rows (non-negotiable #3), managers and super admins
-- read the company's, and nobody signed in may write — ingestion is the API's
-- service-role path, so an employee cannot fabricate or delete a block record.
create policy website_block_events_select_self on public.website_block_events
  for select to authenticated
  using (profile_id = (select auth.uid()));

create policy website_block_events_select_company_managers on public.website_block_events
  for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and (select private.is_manager())
  );

-- ---------------------------------------------------------------------------
-- Seed a settings row for every company, present and future.
--
-- Without this a tenant onboarded next month has no settings row, `GET
-- /api/restrictions/enforcement` has no revision to report, and the extension has no
-- way to tell "not configured" from "not reachable".
-- ---------------------------------------------------------------------------

insert into public.website_restriction_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

create or replace function private.seed_restriction_settings_for_new_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.website_restriction_settings (company_id)
  values (new.id)
  on conflict (company_id) do nothing;
  return new;
end;
$$;

create trigger companies_seed_restriction_settings
  after insert on public.companies
  for each row execute function private.seed_restriction_settings_for_new_company();
