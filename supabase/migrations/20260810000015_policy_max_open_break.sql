-- How long a declared break may run before an agent closes the day for the employee.
--
-- A break left open is how an evening becomes tracked time: somebody declares a break
-- at 18:00, shuts the lid, and the day accrues until they come back. Both agents guard
-- against it by treating a break running longer than a limit as one the employee forgot
-- to end, and closing the day BACKDATED TO WHEN THE BREAK BEGAN — ending it at "now"
-- would bank the whole night, ending it at the break start says what actually happened.
--
-- Until this column the limit was a constant compiled into each agent, kept in sync
-- across desktop and Android only by a comment saying so. That is a rule about what a
-- company considers a working day, and it belongs with the rest of the policy an
-- employee consents to — versioned and audited like the screenshot interval, not
-- shipped inside a binary on their laptop.
--
-- The default is 10800 (three hours) because that is exactly what both agents already
-- hardcoded, so applying this migration changes nobody's recorded time. Three hours is
-- deliberately generous — longer than any lunch, a school run or a dentist appointment,
-- so a real break is never cut short — while sitting far below the overnight case this
-- exists to catch. The cost of being wrong is asymmetric in the two directions: too
-- short and a genuine long break becomes a second work session someone has to explain;
-- too long and the dashboard reports a night's sleep as tracked time.
--
-- The agents' fallback constants must equal this default. An agent running before its
-- first policy arrives otherwise applies a different limit from every server-side
-- calculation, which is the defect migration ...0006 already had to fix once for
-- `idle_threshold_seconds`.

alter table public.policies
  add column max_open_break_seconds integer not null default 10800
    -- The lower bound is 15 minutes: below that the guard stops catching forgotten
    -- breaks and starts cutting real ones short, which lands as invented work sessions
    -- in someone's timeline. The upper bound is 12 hours — a limit longer than that
    -- cannot catch the overnight case it exists for, so it is the feature switched off
    -- while still reading as configured.
    check (max_open_break_seconds between 900 and 43200);

comment on column public.policies.max_open_break_seconds is
  'Seconds a declared break may run before the agent ends the day, backdated to the break start. Enforced on the agent; the column is the policy value handed out at enrolment.';
