-- One device per person is the system of record for working hours.
--
-- Why this exists. Idle was not device-scoped: `buildDayTimeline` unions a person's
-- activity, idle and breaks across every machine they carry and then subtracts idle
-- from activity, so a laptop sitting untouched cancelled work genuinely being done on
-- a phone at the same moment —
--
--     laptop  10:00 ──── idle ──── 11:00     (away from the desk)
--     phone   10:30 ─ active ───── 11:00     (working in the CRM)
--     counted: idle 60m, active 0m
--
-- — which is the exact profile of a field employee with a laptop at base. Naming a
-- primary device answers it the way the client asked for: hours come from the machine
-- that is meant to measure them, and the others report their own time beside it
-- instead of corrupting it.
--
-- On `devices` rather than a `profiles.primary_device_id` column. Migrations ...0005
-- and ...0011 both exist because a new column on `profiles` reopened the self-update
-- hole, and CLAUDE.md requires the whole RLS suite re-run after any of them. Nothing
-- here touches `profiles`, so neither applies. It also means the flag dies with the
-- device rather than leaving a dangling reference when one is deleted.
--
-- Nobody is made primary by this migration. Absent a choice, every read behaves
-- exactly as it does today — the union across all devices — so this changes no
-- number until an administrator makes a decision.

alter table public.devices
  add column is_primary boolean not null default false;

-- One primary per person, enforced here rather than in a handler. Two rows claiming to
-- be the system of record is not a state the API should have to resolve at read time,
-- and a partial index is what makes "at most one" cost nothing when the answer is none.
create unique index devices_one_primary_per_profile
  on public.devices (profile_id)
  where is_primary;

comment on column public.devices.is_primary is
  'The machine whose activity and idle define this person''s working hours. At most one per profile. When no device is primary, hours are the union across all of them.';
