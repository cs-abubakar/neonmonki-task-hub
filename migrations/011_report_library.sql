-- NEONMONKI Task Hub — migration 011: report library
-- Run after 010 in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- The Reports page library: curated report links (Google Drive decks,
-- dashboards, …) grouped by month and kind (weekly | monthly | special).
-- Team members add entries, the super admin edits/deletes, clients read.
-- All access goes through the server — same lock-down as every other
-- table: RLS on, no policies; only the service role key can read or write.

create table if not exists report_library (
  id           bigint generated always as identity primary key,
  title        text not null,
  description  text not null default '',
  kind         text not null default 'weekly',      -- weekly | monthly | special
  period_month text not null,                       -- YYYY-MM
  links        jsonb not null default '[]',         -- [{label, url}]
  created_by   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table report_library enable row level security;
