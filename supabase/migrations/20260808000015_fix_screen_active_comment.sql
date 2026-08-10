-- `device_telemetry.screen_active_seconds` is a running daily total, not a delta.
--
-- Migration ...0004 introduced the column with the comment "Android: time the screen
-- was on since the previous sample." That is wrong, and it is the dangerous direction
-- of wrong: it invites a report to SUM the column, which would multiply a day's screen
-- time by the number of samples taken.
--
-- What the agent actually sends is `ScreenTimeTracker.getTodaySeconds`, which reads an
-- accumulator reset at local midnight by `resetIfNewDay`. Confirmed against live rows
-- before this was written — one device climbed 56 -> 559 -> 617 -> 766 -> 917 -> 1097
-- inside a single day, which is an accumulator, not a series of intervals.
--
-- So: the NEWEST sample is the answer for that day. Never the sum.
--
-- Nothing sums it today. This exists so that stays true — a comment in the database is
-- what the next person writing a report will read, and ...0004's is still in the file
-- history where it cannot be edited.

comment on column public.device_telemetry.screen_active_seconds is
  'Android only. Screen-on seconds since LOCAL MIDNIGHT — a running daily total, not a '
  'delta since the previous sample. Take the newest row for a day; never SUM these.';
