-- NEONMONKI Task Hub — migration 007: Smart Reporting (Hyros connector)
-- Run after 006 in the Supabase SQL Editor (idempotent).
--
-- Model: Hyros = upstream source. reporting_facts = normalized source-of-truth
-- for dashboards/AI. integration_connections holds connection state (secrets
-- encrypted server-side; RLS on, service-key only).

create table if not exists integration_connections (
  id                 text primary key,            -- 'hyros'
  name               text not null default 'HYROS',
  status             text not null default 'disconnected', -- connected | error | disconnected
  account_name       text default '',
  api_key_encrypted  text default '',             -- AES-256-GCM, server-side only
  webhook_token_hash text default '',             -- sha256 of the webhook token
  webhook_secret_encrypted text default '',       -- Hyros ssk-… (signature verification)
  historical_days    integer not null default 90,
  last_sync_at       timestamptz,
  last_webhook_at    timestamptz,
  last_error         text default '',
  backfill           jsonb not null default '{}',   -- resume cursor {cursor, done}
  connected_by       text default '',
  connected_at       timestamptz,
  disconnected_by    text default '',
  disconnected_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists hyros_sync_runs (
  id             bigint generated always as identity primary key,
  integration_id text not null default 'hyros',
  kind           text not null default 'incremental', -- backfill | incremental | webhook | test
  range_from     text default '',
  range_to       text default '',
  status         text not null default 'running',     -- running | complete | failed
  records_in     integer not null default 0,
  error          text default '',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists hyros_sync_runs_idx on hyros_sync_runs(integration_id, id desc);

-- normalized reporting facts. One row per source event (lead/sale/call).
-- Spend/impression/click aggregates live in reporting_daily (per day/channel).
create table if not exists reporting_facts (
  id             bigint generated always as identity primary key,
  source_system  text not null default 'hyros',     -- hyros | manual | future connectors
  integration_id text not null default 'hyros',
  external_id    text not null,                     -- hyros entity id / webhook eventId
  event_type     text not null,                     -- lead | sale | call | refund | subscription
  event_at       timestamptz not null,              -- source event time (UTC)
  channel        text not null default 'Unknown',   -- normalized channel
  platform       text not null default 'Other',     -- normalized platform
  source_name    text default '',                   -- trafficSource.name / source link name
  campaign       text default '',                   -- category name
  ad_account     text default '',
  goal           text default '',
  tags           text default '',                   -- $product / @source / !event tags
  is_organic     boolean not null default false,
  is_qualified   boolean,
  value          numeric not null default 0,        -- revenue for sales/refunds (negative on refund)
  currency       text default 'EUR',
  lead_id        text default '',
  sale_id        text default '',
  order_id       text default '',
  raw            jsonb,                             -- audit payload (trimmed)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists reporting_facts_unique on reporting_facts(source_system, event_type, external_id);
create index if not exists reporting_facts_event_at on reporting_facts(event_at);
create index if not exists reporting_facts_channel on reporting_facts(channel);
create index if not exists reporting_facts_platform on reporting_facts(platform);
create index if not exists reporting_facts_source on reporting_facts(source_name);
create index if not exists reporting_facts_campaign on reporting_facts(campaign);

-- daily performance aggregates (spend/clicks/impressions come from Hyros
-- /attribution endpoints, or manual entries). One row per day×channel×platform.
create table if not exists reporting_daily (
  id           bigint generated always as identity primary key,
  source_system text not null default 'hyros',
  day          date not null,
  channel      text not null default 'Unknown',
  platform     text not null default 'Other',
  spend        numeric not null default 0,
  clicks       numeric not null default 0,
  impressions  numeric not null default 0,
  leads        numeric not null default 0,
  sales        numeric not null default 0,
  revenue      numeric not null default 0,
  updated_at   timestamptz not null default now(),
  unique (source_system, day, channel, platform)
);
create index if not exists reporting_daily_day on reporting_daily(day);

alter table integration_connections enable row level security;
alter table hyros_sync_runs        enable row level security;
alter table reporting_facts        enable row level security;
alter table reporting_daily        enable row level security;
