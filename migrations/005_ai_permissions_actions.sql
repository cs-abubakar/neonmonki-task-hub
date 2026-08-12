-- NEONMONKI Task Hub — migration 005: per-user AI access + proposal provenance
-- Run after 004 in the Supabase SQL Editor. Safe to re-run.

create table if not exists ai_user_permissions (
  username      text primary key references users(username) on delete cascade,
  enabled       boolean not null default true,
  tools         jsonb,                       -- null = inherit every currently available tool
  daily_limit   integer,                     -- null = inherit the global daily limit
  updated_by    text default '',
  updated_at    timestamptz not null default now()
);

alter table ai_action_requests add column if not exists modified_payload jsonb not null default '{}';
alter table ai_action_requests add column if not exists execution_result jsonb not null default '{}';
alter table ai_action_requests add column if not exists updated_at timestamptz not null default now();

alter table ai_user_permissions enable row level security;
