-- NEONMONKI Task Hub — migration 012: clients registry + external collaborators
-- Run after 011 in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- clients: the client registry (NEONMONKI today, more later). Client-role
-- users are scoped to their own client's tasks/reports; team/super_admin are
-- never client-bound (their users.client_id stays '').
-- external: the new user role for outside collaborators (e.g. an external
-- developer) — the boundary itself lives in lib/permissions.js.
--
-- All access goes through the server — same lock-down as every other table:
-- RLS on, no policies; only the service role key can read or write.

create table if not exists clients (
  id         text primary key,
  name       text not null,
  active     boolean not null default true,
  notes      text not null default '',
  created_at timestamptz not null default now()
);

alter table users add column if not exists client_id text not null default '';
alter table tasks add column if not exists client_id text not null default 'neonmonki';
-- Departments are stored as SYS-DEPT-* rows in the decisions table — there is
-- no physical departments table today, so this alter is a forward-compat no-op.
alter table if exists departments add column if not exists external boolean not null default false;
alter table report_library add column if not exists client_id text not null default 'neonmonki';

alter table clients enable row level security;  -- no policies: service-role only
