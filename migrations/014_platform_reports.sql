-- NEONMONKI Task Hub — migration 014: Platform Reports (GSC + Clarity)
-- Run after 013 in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Platform Reports reuses integration_connections for connection state (ids
-- "gsc" / "clarity" — one new generic `meta` jsonb column carries per-platform
-- extras like the selected GSC property) and hyros_sync_runs for run history
-- (integration_id distinguishes the connector).
--
-- platform_daily stores normalized per-day rows:
--   GSC     — slice_type date|query|page, slice_value ''|query|page path,
--             metric '' with clicks/impressions/ctr/position columns
--   Clarity — slice_type overall|device|source|url, slice_value value,
--             metric = the Clarity metric name, value = its number
-- Upserts key on (platform, day, slice_type, slice_value, metric), so syncs
-- are idempotent and re-running any window is free.

alter table integration_connections add column if not exists meta jsonb not null default '{}';

create table if not exists platform_daily (
  id           bigint generated always as identity primary key,
  platform     text not null,                 -- gsc | clarity
  day          date not null,
  slice_type   text not null default 'date',  -- date | query | page | overall | device | source | url
  slice_value  text not null default '',
  metric       text not null default '',      -- '' for GSC rows; Clarity metric name otherwise
  clicks       numeric,                       -- GSC
  impressions  numeric,                       -- GSC
  ctr          numeric,                       -- GSC (fraction, e.g. 0.042)
  position     numeric,                       -- GSC average position
  value        numeric,                       -- Clarity metric value
  synced_at    timestamptz not null default now()
);

create unique index if not exists platform_daily_key
  on platform_daily (platform, day, slice_type, slice_value, metric);
create index if not exists platform_daily_platform_day_idx
  on platform_daily (platform, day desc);
create index if not exists platform_daily_slice_idx
  on platform_daily (platform, slice_type, day desc);

alter table platform_daily enable row level security;  -- no policies: service-role only
