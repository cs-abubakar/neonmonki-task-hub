-- NEONMONKI Task Hub — migration 010: per-user reporting access tier
-- Run after 009 in the Supabase SQL Editor. Safe to re-run.
--
-- Smart Reporting is growing a second tier:
--   full  — the owner's Smart Reporting dashboard + all /api/reporting/*
--   basic — the calm client-safe Performance page (/api/reporting/basic)
--   none  — no reporting
-- The ai_user_permissions row gains `reporting`: '' (inherit the role
-- default — super_admin=full, client/team=basic), 'full', 'basic' or 'none'.
-- Role defaults live in lib/permissions.js (reportingAccess); this column is
-- only the explicit per-user override.

-- 005's table was never created in production (the driver silently fell back
-- to the ai_settings JSON blob) — create it first so the alter cannot fail.
create table if not exists ai_user_permissions (
  username      text primary key references users(username) on delete cascade,
  enabled       boolean not null default true,
  tools         jsonb,                       -- null = inherit every currently available tool
  daily_limit   integer,                     -- null = inherit the global daily limit
  updated_by    text default '',
  updated_at    timestamptz not null default now()
);

alter table ai_user_permissions add column if not exists reporting text not null default '';

alter table ai_user_permissions enable row level security;
