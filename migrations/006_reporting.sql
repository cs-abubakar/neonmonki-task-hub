-- NEONMONKI Task Hub — migration 006: reporting layer
-- Run after 005 in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Adds the management-first reporting surface:
--   - metrics: manually entered channel results (SEO clicks, ad spend, …)
--   - tasks.impact: business-impact context on any task (critical work explains
--     why it matters)
--   - users.last_seen_at: powers the "what changed since your last visit" stamp
--   - ai_reports: stored Monki period reports per audience (team / client)

create table if not exists metrics (
  id          bigint generated always as identity primary key,
  date        text not null,               -- YYYY-MM-DD (entry day)
  channel     text not null,               -- e.g. "SEO", "Google Ads"
  metric      text not null,               -- e.g. "organic_clicks", "spend"
  value       double precision not null,
  note        text default '',
  created_by  text default '',
  ts          timestamptz not null default now()
);
create index if not exists metrics_date_idx on metrics(date);

alter table tasks add column if not exists impact text default '';
alter table users add column if not exists last_seen_at timestamptz;

create table if not exists ai_reports (
  id          bigint generated always as identity primary key,
  audience    text default 'team',         -- 'team' | 'client'
  period_from text,
  period_to   text,
  text        text,
  citations   jsonb default '[]',
  created_by  text,
  ts          timestamptz not null default now()
);

-- Same lock-down as every other table: RLS on, no policies; only the
-- server-side service role key can read or write.
alter table metrics enable row level security;
alter table ai_reports enable row level security;
