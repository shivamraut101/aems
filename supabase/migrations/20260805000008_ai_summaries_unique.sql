-- One AI summary per subject, per kind, per period.
--
-- The worker used to `.insert()`, and nothing stopped it. Re-running the daily job
-- — after a provider outage, a redeploy, or a manual backfill — appended a second
-- row for the same day with different prose, and no rule said which one the UI
-- should show. This index turns the re-run into an idempotent upsert.
--
-- `nulls not distinct` is the load-bearing part. A company-wide `insight` row has a
-- null `profile_id`, and under Postgres's default rule two nulls never conflict, so
-- the plain unique index would have deduplicated per-employee summaries while
-- letting the company insight duplicate exactly as before — the harder bug, because
-- it would look fixed. Requires Postgres 15+; the project runs 17.6 and
-- `supabase/config.toml` pins major_version = 17.
--
-- Deliberately NOT changed: `profiles`, and no new column anywhere. The upsert
-- replaces `content`, `provider` and `model` in place and leaves `created_at` as the
-- moment the period was first summarised.

-- ---------------------------------------------------------------------------
-- 1. Collapse any duplicates that were written before the constraint existed
-- ---------------------------------------------------------------------------

-- Keeps the highest id, which is the most recent write for that period. Runs
-- before the index because `create unique index` on a table with duplicates fails
-- and would leave the migration half-applied.
delete from public.ai_summaries a
using public.ai_summaries b
where a.company_id = b.company_id
  and a.kind = b.kind
  and a.period_start = b.period_start
  and a.profile_id is not distinct from b.profile_id
  and a.id < b.id;

-- ---------------------------------------------------------------------------
-- 2. The uniqueness the worker upserts against
-- ---------------------------------------------------------------------------

create unique index if not exists ai_summaries_subject_period_key
  on public.ai_summaries (company_id, profile_id, kind, period_start)
  nulls not distinct;

comment on index public.ai_summaries_subject_period_key is
  'Conflict target for ai-summary-worker''s upsert. NULLS NOT DISTINCT so a company-wide insight (profile_id is null) cannot be written twice for the same week.';
