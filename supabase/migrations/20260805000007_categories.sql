-- Activity categorisation rules (scope §2.4, §2.5, §4.4, §5, §6).
--
-- Every `activity_events.category` written before this migration is NULL, because
-- nothing ever produced one: the column existed, the API accepted the field, and the
-- agent never sent it. That made `docs/design.md`'s Work Pattern block — Focused Time
-- / Collaboration / Idle — impossible to compute and left the application list with
-- nothing to group by.
--
-- Rules live in the database rather than in the agent on purpose. They are company
-- data that a super admin changes without shipping a release, and an agent-side engine
-- would have to be rebuilt for the Android agent and again for any Phase 2 desktop
-- rewrite. The matcher itself is `packages/analytics/src/categorize.ts`, applied at
-- ingestion (so stored rows carry a category) and re-appliable at read time (so a rule
-- added today relabels yesterday with no backfill).
--
-- Deliberately NOT done here: adding a column to `profiles`. That would oblige a
-- re-run of `supabase/tests/rls_isolation.sql`, and nothing about categorisation
-- belongs on a person.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.category_rules (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,

  -- Lower runs first; the engine stops at the first rule that matches. An ordered
  -- list is what a manager can defend to an employee — "your Slack time was
  -- Communication because rule 30 matched" — which a deepest-path-wins scheme is not.
  priority      integer not null default 100 check (priority >= 0),

  -- Hierarchy, outermost first: {Work,Development}. Stored as a path rather than one
  -- label so a report can collapse to depth 1 and drill to depth 2 without a second
  -- table. `Uncategorized` is the engine's fallback and is never stored as a rule.
  category_path text[] not null
                check (
                  cardinality(category_path) between 1 and 4
                  and array_position(category_path, null::text) is null
                  and array_position(category_path, ''::text) is null
                ),

  -- Tri-state, which ActivityWatch deliberately does not have and every commercial
  -- product in this category does. `neutral` is the honest bucket for "in use, but we
  -- will not call it productive".
  productivity  text not null default 'neutral'
                check (productivity in ('productive', 'neutral', 'unproductive')),

  -- Regex sources, matched per field and ANDed. Matching one pattern against every
  -- column at once — as ActivityWatch does — makes a Programming rule fire on a Slack
  -- window whose title merely mentions GitHub. Our columns are already separate, so
  -- that false positive is avoidable for free.
  match_app     text check (match_app is null or length(match_app) between 1 and 400),
  match_title   text check (match_title is null or length(match_title) between 1 and 400),

  -- A bare hostname here is matched as a *suffix*: `example.com` claims
  -- `app.example.com` and never `notexample.com`. A pattern containing anything else
  -- is treated as an unanchored regex, which has no such guarantee — anchor it.
  match_domain  text check (match_domain is null or length(match_domain) between 1 and 400),

  ignore_case   boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A rule with no condition would either match nothing or match everything, and both
  -- are traps. Refuse it here as well as in the engine.
  constraint category_rules_has_condition
    check (match_app is not null or match_domain is not null or match_title is not null)
);

-- Two rules may legitimately share a category — "Chrome on github.com" and "the Code
-- application" are both Work > Development — so there is deliberately no unique
-- constraint on (company_id, category_path). The evaluation order is total without
-- one: priority, then path depth, then id.
create index category_rules_company_priority_idx
  on public.category_rules (company_id, priority, id);

create trigger category_rules_set_updated_at
  before update on public.category_rules
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.category_rules enable row level security;

-- The whole company reads. An employee is entitled to see the rules being applied to
-- their own activity — non-negotiable #3 in spirit: a classification they cannot
-- inspect is a judgement made about them in private.
create policy category_rules_select_company on public.category_rules
  for select to authenticated
  using (company_id = (select private.current_company_id()));

-- Only super admins write. A manager who could rewrite the rules could rewrite the
-- report they are about to present, which destroys the evidentiary value of the record.
create policy category_rules_write_super_admin on public.category_rules
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
-- Default rule set
--
-- Written around what this client actually runs, and around the three axes
-- `docs/design.md` already names — Development, Communication, Research.
-- ActivityWatch's default tree is deliberately NOT transcribed: it is MPL-2.0 source
-- data and it is tuned for a hobbyist Linux desktop.
--
-- Domain patterns that cover several hosts are written anchored — `(^|\.)x\.com$` —
-- because a grouping pattern stops being a bare hostname and therefore stops getting
-- the automatic suffix guarantee. Unanchored, `(facebook|x)\.com` would also claim
-- `notfacebook.com`.
--
-- Domain rules run before application rules on purpose: a browser is not a category,
-- the site open in it is. Chrome time with no domain stays Uncategorized, which is
-- honest rather than flattering.
-- ---------------------------------------------------------------------------

create or replace function private.seed_default_category_rules(target_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- No-op when the company has already been seeded or has authored its own rules;
  -- re-running the migration must never resurrect a rule a super admin deleted.
  if exists (select 1 from public.category_rules where company_id = target_company) then
    return;
  end if;

  insert into public.category_rules
    (company_id, priority, category_path, productivity, match_app, match_domain, match_title)
  values
    -- Websites first. Note the ordering inside the google.com family: the specific
    -- hosts have to be claimed before the generic search rule, or `mail.google.com`
    -- lands in Research and the Communication total is quietly wrong.
    (target_company, 10, array['Work','Development'],   'productive',   null, '(^|\.)(?:github|gitlab|bitbucket)\.(?:com|org)$', null),
    (target_company, 11, array['Work','Development'],   'productive',   null, 'npmjs.com',        null),
    (target_company, 12, array['Work','Development'],   'productive',   null, 'localhost',        null),
    (target_company, 20, array['Work','Research'],      'productive',   null, 'stackoverflow.com', null),
    (target_company, 21, array['Work','Research'],      'productive',   null, '(^|\.)(?:developer\.mozilla\.org|readthedocs\.(?:io|org))$', null),
    (target_company, 25, array['Work','Communication'], 'productive',   null, '(^|\.)(?:slack\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|meet\.google\.com)$', null),
    (target_company, 26, array['Work','Communication'], 'productive',   null, '(^|\.)(?:mail\.google\.com|outlook\.(?:office|live)\.com|outlook\.com)$', null),
    (target_company, 27, array['Work','Documents'],     'productive',   null, '(^|\.)docs\.google\.com$', null),
    (target_company, 28, array['Work','Documents'],     'productive',   null, '(^|\.)(?:notion\.so|atlassian\.net|linear\.app|asana\.com|trello\.com)$', null),
    (target_company, 30, array['Work','Research'],      'productive',   null, '(^|\.)(?:google\.(?:com|co\.uk)|bing\.com|duckduckgo\.com)$', null),
    (target_company, 50, array['Personal','Social'],    'unproductive', null, '(^|\.)(?:facebook|instagram|tiktok|reddit|linkedin)\.com$', null),
    (target_company, 51, array['Personal','Social'],    'unproductive', null, 'x.com',            null),
    (target_company, 60, array['Personal','Entertainment'], 'unproductive', null, '(^|\.)(?:youtube|netflix|twitch|spotify)\.(?:com|tv)$', null),
    (target_company, 61, array['Personal','Shopping'],  'unproductive', null, '(^|\.)(?:amazon|ebay|aliexpress)\.(?:com|co\.uk|in)$', null),

    -- Applications second, so a browser never wins over the site inside it.
    (target_company, 70, array['Work','Development'],   'productive',   '^(?:Code|Visual Studio|VSCodium|Cursor|IntelliJ|WebStorm|PyCharm|GoLand|Rider|Android Studio|Xcode|Sublime Text|Neovim|Vim|Emacs)', null, null),
    (target_company, 71, array['Work','Development'],   'productive',   '^(?:Terminal|iTerm|Windows Terminal|WindowsTerminal|PowerShell|Command Prompt|Warp|Alacritty|Docker Desktop|Postman|TablePlus|pgAdmin|DBeaver)', null, null),
    (target_company, 75, array['Work','Communication'], 'productive',   '^(?:Slack|Microsoft Teams|Teams|Zoom|Discord|Outlook|Mail|Thunderbird|Webex)', null, null),
    (target_company, 80, array['Work','Design'],        'productive',   '^(?:Figma|Sketch|Adobe (?:XD|Photoshop|Illustrator)|Affinity)', null, null),
    (target_company, 85, array['Work','Documents'],     'productive',   '^(?:Microsoft (?:Word|Excel|PowerPoint)|WINWORD|EXCEL|POWERPNT|Notion|Obsidian|Preview|Acrobat)', null, null),
    (target_company, 90, array['Personal','Entertainment'], 'unproductive', '^(?:Spotify|VLC|Steam|Netflix|Music|TV)', null, null),

    -- Neutral, not unproductive: a file manager or a settings pane is the machine
    -- being used, and counting it against someone would be nonsense.
    (target_company, 95, array['System','Utilities'],   'neutral',      '^(?:Finder|Explorer|explorer|System (?:Settings|Preferences)|Settings|Control Panel|Activity Monitor|Task Manager|Installer|LockApp|SystemUIServer)', null, null);
end;
$$;

-- Existing companies.
do $$
declare
  c uuid;
begin
  for c in select id from public.companies loop
    perform private.seed_default_category_rules(c);
  end loop;
end $$;

-- And every company created from here on. Without this a tenant onboarded next month
-- silently has zero rules, every event folds into Uncategorized, and the Work Pattern
-- block goes blank with nothing on screen to explain why.
create or replace function private.seed_category_rules_for_new_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_category_rules(new.id);
  return new;
end;
$$;

create trigger companies_seed_category_rules
  after insert on public.companies
  for each row execute function private.seed_category_rules_for_new_company();
