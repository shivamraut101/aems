-- How long a declared break may run before the agent closes the day for the employee.
--
-- Was a constant compiled into both agents (3h). It is a judgement call about how a
-- particular workforce actually breaks — a school run, a half-day, a site visit — so it
-- belongs with the other policy knobs an admin sets, not in a binary on someone's laptop.
--
-- The floor is one hour: shorter than that and a genuine lunch becomes a second work
-- session the employee has to explain. There is no ceiling in the column beyond the
-- API's, because the honest upper bound is "well short of overnight" and that is a
-- judgement the check constraint cannot make.
alter table public.policies
  add column max_open_break_seconds integer not null default 18000
  check (max_open_break_seconds >= 3600);

comment on column public.policies.max_open_break_seconds is
  'A break open longer than this is treated as one the employee forgot to end; the day '
  'is closed backdated to when the break began. Default 5h.';
