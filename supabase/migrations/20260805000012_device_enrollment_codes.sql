-- Device enrolment codes.
--
-- Enrolment used to require pasting a raw Supabase access token into the agent. That
-- is not a credential a person can be handed: it is 800 characters of JWT, it grants
-- the FULL rights of the account rather than the one act of binding a machine, and it
-- lives for an hour wherever it was copied — chat, a sticky note, a clipboard manager.
--
-- A code fixes all three. It is short enough to read aloud, it authorises exactly one
-- device enrolment for exactly one person, and it dies on first use or in ten minutes.
--
-- The plaintext is NEVER stored. Only a SHA-256 hash lands here, so a database leak
-- yields nothing usable, and the lookup is by hash — which also means no enumeration:
-- there is no "list codes" read path that could expose one.

create table if not exists public.device_enrollment_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Whose device this will become. Fixed at mint time, so a code cannot be redirected
  -- to another person by whoever ends up holding it.
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- SHA-256 of the plaintext, hex. Unique so a hash collision cannot silently shadow
  -- an existing live code.
  code_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_device_id uuid references public.devices (id) on delete set null,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- A code that is consumed must say which device consumed it. Without this the audit
  -- trail can show a code was used but not what it produced.
  constraint device_enrollment_codes_consumed_together
    check ((consumed_at is null) = (consumed_device_id is null))
);

comment on table public.device_enrollment_codes is
  'Short-lived, single-use codes that let an agent bind a machine without handling a Supabase session. Plaintext is never stored — only its SHA-256 hash.';

-- The redemption path looks a code up by hash and then checks liveness, so the hash is
-- the access path and is already unique above. This partial index serves the other
-- direction: "does this person have a live code already?", which the dashboard asks
-- every time the Add device dialog opens.
create index if not exists device_enrollment_codes_live_idx
  on public.device_enrollment_codes (profile_id, expires_at)
  where consumed_at is null;

create index if not exists device_enrollment_codes_company_idx
  on public.device_enrollment_codes (company_id);
create index if not exists device_enrollment_codes_created_by_idx
  on public.device_enrollment_codes (created_by);

alter table public.device_enrollment_codes enable row level security;

-- Read: a person sees codes minted for them; managers and super admins see their whole
-- company's. Reading a row reveals only the HASH, never the code — this exists so the
-- dashboard can say "a code is already live, it expires at 14:32" rather than minting a
-- second one every time the dialog is opened.
create policy device_enrollment_codes_select on public.device_enrollment_codes
  for select
  using (
    company_id = (select private.current_company_id())
    and (
      profile_id = (select auth.uid())
      or (select private.is_manager())
    )
  );

-- Write goes through the API, which holds the service-role key and does its own
-- checking. No insert, update or delete policy exists for authenticated roles on
-- purpose: minting a code is granting device-binding rights, and PostgREST is not the
-- place that decision should be made.

-- Redemption happens through the API too, under the service-role key, because the
-- agent redeeming a code has no Supabase session at all — that is the entire point.

-- Amended after the constraint above blocked a legitimate delete.
--
-- Requiring consumed_at and consumed_device_id to be set or null TOGETHER is wrong the
-- moment a device is removed: the FK's ON DELETE SET NULL clears consumed_device_id
-- while consumed_at remains, the check fires, and the DELETE on public.devices fails.
-- A device could not be deleted once it had redeemed a code.
--
-- The property worth enforcing is one-directional — a consuming device may not be
-- recorded without a consumption time. The reverse is legitimate history: "this code
-- was used, and the device it produced has since been deleted."
alter table public.device_enrollment_codes
  drop constraint if exists device_enrollment_codes_consumed_together;

alter table public.device_enrollment_codes
  add constraint device_enrollment_codes_consumed_device_needs_time
  check (consumed_at is not null or consumed_device_id is null);
