-- ---------------------------------------------------------------------------
-- Reports could not describe themselves.
--
-- `kind` was constrained to daily | weekly | team and the worker read it only to
-- name the output file, so all three produced byte-identical CSVs. The row also
-- recorded no format, no grouping, no scope and no reason for a failure — the
-- cause of a failed report lived only in an Edge Function log.
--
-- This widens the row to carry the whole request. The three legacy kinds stay
-- permitted so rows already queued keep validating.
-- ---------------------------------------------------------------------------

alter table public.reports
  add column if not exists format          text not null default 'csv',
  add column if not exists grouping        text not null default 'employee',
  -- Scope, profile ids and the decimal-duration flag. Same tenant as the row, so
  -- the existing company_id policies already cover it.
  add column if not exists params          jsonb not null default '{}'::jsonb,
  add column if not exists requested_by    uuid references public.profiles (id) on delete set null,
  add column if not exists row_count       integer,
  add column if not exists failure_reason  text;

alter table public.reports
  drop constraint if exists reports_format_check;

alter table public.reports
  add constraint reports_format_check check (format in ('csv', 'pdf'));

alter table public.reports
  drop constraint if exists reports_kind_check;

alter table public.reports
  add constraint reports_kind_check check (
    kind in (
      -- Legacy, kept so queued rows stay valid. New requests use the four below.
      'daily', 'weekly', 'team',
      'time_and_activity', 'app_usage', 'website_usage', 'work_breaks'
    )
  );

-- The worker drains this queue oldest-first; without the index that is a seq scan
-- over every report ever generated, every two minutes.
create index if not exists reports_pending_idx
  on public.reports (created_at)
  where status = 'pending';
