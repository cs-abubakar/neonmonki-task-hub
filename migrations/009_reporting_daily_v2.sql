-- NEONMONKI Task Hub — migration 009: Smart Reporting daily aggregates v2
-- Run after 008 in the Supabase SQL Editor (idempotent: drops and recreates).
--
-- The v1 reporting_daily (007) was a day×channel×platform rollup with no scope
-- or campaign granularity, and was never written to (EMPTY in production), so
-- drop + recreate is safe.
--
-- v2 carries three row scopes:
--   account  — one row per day × ad account, from hyros_get_roas_report
--              (authoritative paid spend/revenue series, sale-date basis).
--   campaign — one row per day × campaign, from hyros_get_attribution_report
--              (DAY grouping; adds leads/clicks/impressions).
--   channel  — one row per day × channel/platform rollup of reporting_facts
--              (organic has no spend; clicks/impressions stay NULL there).
-- clicks/impressions/aov are NULL when untracked — never fake 0 into a metric
-- that the UI would render as real.

drop table if exists reporting_daily;

create table reporting_daily (
  id            bigint generated always as identity primary key,
  source_system text not null default 'hyros',
  day           date not null,
  scope         text not null,                  -- account | campaign | channel
  channel       text not null default 'Unknown',
  platform      text not null default 'Other',
  ad_account    text not null default '',
  campaign_id   text not null default '',
  campaign_name text not null default '',
  spend         numeric not null default 0,
  clicks        numeric,                        -- null = untracked / unavailable
  impressions   numeric,                        -- null = untracked / unavailable
  leads         numeric not null default 0,
  sales         numeric not null default 0,
  revenue       numeric not null default 0,
  aov           numeric,                        -- null = not computable
  synced_at     timestamptz not null default now(),
  unique (source_system, day, scope, platform, ad_account, campaign_id)
);
create index reporting_daily_day on reporting_daily(day);

alter table reporting_daily enable row level security;
-- No policies: service-role only, same as the other Smart Reporting tables (007).
