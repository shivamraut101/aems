-- Closes work sessions whose device stopped reporting, and stops them accumulating.
--
-- A session is opened when the agent clocks in and closed when it clocks out. Nothing
-- closes one when the agent simply stops — killed, uninstalled, a laptop that never came
-- back — so the row stays open forever. On 2026-08-10 there were six, the oldest open for
-- 119 hours, every one of them from a device that had not reported in days.
--
-- It is not a cosmetic leak. `clock_out_at is null` reads as "still working" everywhere
-- hours are summed, so one abandoned session quietly adds days to somebody's total, and
-- the person it is added to is an employee.
--
-- **When it ended is a judgement, and the honest answer is the last moment we have
-- evidence for.** Three candidates, most trustworthy first: the last activity the device
-- actually reported, the device's own `last_seen_at`, and failing both the clock-in
-- itself — a session with no evidence of a single minute worked is zero minutes, not
-- however long the row happened to sit there. `greatest` picks between them, and the
-- clock-in floor is what stops a device whose clock was behind closing a session before
-- it started.
--
-- Twelve hours, not one. The threshold has to survive a closed lid over lunch, a long
-- meeting and a flat battery, because closing a live session early invents a clock-out
-- the employee did not make. A day that ends twelve hours late is wrong by less than a
-- day that ends in the middle.

create or replace function private.close_abandoned_sessions(stale_after interval default interval '12 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  closed integer;
begin
  with abandoned as (
    select
      ws.id,
      greatest(
        ws.clock_in_at,
        coalesce(
          (select max(ae.ended_at) from public.activity_events ae where ae.work_session_id = ws.id),
          ws.clock_in_at
        ),
        coalesce(d.last_seen_at, ws.clock_in_at)
      ) as ended_at
    from public.work_sessions ws
    join public.devices d on d.id = ws.device_id
    where ws.clock_out_at is null
      and d.last_seen_at is not null
      and d.last_seen_at < now() - stale_after
  )
  update public.work_sessions ws
  set clock_out_at = abandoned.ended_at
  from abandoned
  where ws.id = abandoned.id;

  get diagnostics closed = row_count;
  return closed;
end;
$$;

comment on function private.close_abandoned_sessions(interval) is
  'Closes work sessions left open by an agent that stopped reporting, at the last moment there is evidence the device was alive. Returns how many were closed. Runs hourly via pg_cron; safe to call by hand.';

-- Hourly, on the hour. The work is a single indexed update over the handful of rows that
-- are open at all, so the cost of running it often is lower than the cost of reasoning
-- about how stale the numbers are between runs.
--
-- pg_cron rather than an Edge Function: this touches no HTTP, no secret and no other
-- service, and an Edge Function would need deploying and scheduling by something anyway
-- — which on Supabase is this. `docs/stack.md` §9 rules out a separate worker *runtime*;
-- this adds none.
create extension if not exists pg_cron with schema extensions;

select cron.unschedule('close-abandoned-sessions')
where exists (select 1 from cron.job where jobname = 'close-abandoned-sessions');

select cron.schedule(
  'close-abandoned-sessions',
  '7 * * * *',
  $$select private.close_abandoned_sessions()$$
);
