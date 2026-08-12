-- NEONMONKI Task Hub — migration 003: AI foundation
-- Run after 001/002 in the Supabase SQL Editor. Idempotent.
--
-- Design notes:
-- * KIMI_API_KEY can live in hosting env. The Control Center may alternatively
--   persist an AES-GCM-encrypted key inside reserved server-only feature
--   metadata; plaintext is never stored or returned to the browser.
-- * ai_audit logs actions and outcomes (who/what/tools/records/tokens/status),
--   never prompts or chain-of-thought.
-- * ai_summaries are clearly-labeled AI-generated artifacts — they never
--   overwrite factual tables (tasks/messages/decisions stay the source of truth).
-- * ai_action_requests stores the human approval trail for interactive AI
--   proposals. ai_agents remains reserved for a possible later phase.

create table if not exists ai_settings (
  id           smallint primary key default 1 check (id = 1),  -- singleton row
  enabled      boolean not null default false,
  model        text not null default 'kimi-k2.6',
  features     jsonb not null default '{"ask":true,"chat":true,"brief":true,"summaries":true}',
  allow_client boolean not null default true,   -- client may use AI (client-safe context only)
  daily_limit  integer not null default 60,     -- AI calls per user per day
  updated_by   text default '',
  updated_at   timestamptz not null default now()
);

create table if not exists ai_audit (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  username          text not null,
  kind              text not null,        -- ask | task_summary | channel_summary | brief | test
  question          text default '',      -- the user's request (no model reasoning)
  tools             jsonb not null default '[]',   -- tool names actually executed
  citations         jsonb not null default '[]',   -- records the answer was based on
  model             text default '',
  prompt_tokens     integer default 0,
  completion_tokens integer default 0,
  latency_ms        integer default 0,
  status            text not null default 'ok',    -- ok | error | disabled | rate_limited
  error             text default ''
);
create index if not exists ai_audit_ts_idx on ai_audit(ts desc);
create index if not exists ai_audit_user_idx on ai_audit(username, ts desc);

create table if not exists ai_summaries (
  id         bigint generated always as identity primary key,
  scope_type text not null,               -- task | channel | brief
  scope_id   text not null,               -- task id / channel id / username (brief)
  text       text not null,
  citations  jsonb not null default '[]',
  model      text default '',
  created_by text default '',             -- who triggered it
  ts         timestamptz not null default now()
);
create index if not exists ai_summaries_scope_idx on ai_summaries(scope_type, scope_id, ts desc);

-- Human approval queue for interactive AI-proposed actions.
create table if not exists ai_action_requests (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  agent_id    text default '',            -- '' = interactive user-driven AI
  username    text default '',            -- who the action is attributed to
  action_type text not null,              -- create_task | update_task | create_decision | ...
  payload     jsonb not null default '{}',
  status      text not null default 'pending',  -- pending | approved | modified | rejected | executed
  decided_by  text default '',
  decided_at  timestamptz,
  note        text default ''
);

-- FUTURE (not wired yet): AI employee definitions.
create table if not exists ai_agents (
  id           text primary key,          -- slug, e.g. "paid-media-analyst"
  name         text not null,
  role_title   text default '',
  instructions text default '',
  scopes       jsonb not null default '{}',  -- channels/tasks/files access definition
  tools        jsonb not null default '[]',  -- allowed tool names
  autonomy     text not null default 'ask',  -- ask | draft | auto
  active       boolean not null default false,
  created_by   text default '',
  created_at   timestamptz not null default now()
);

alter table ai_settings         enable row level security;
alter table ai_audit            enable row level security;
alter table ai_summaries        enable row level security;
alter table ai_action_requests  enable row level security;
alter table ai_agents           enable row level security;
