-- NEONMONKI Task Hub — migration 002: chat, users, notifications
-- Run in: Supabase Dashboard → SQL Editor → paste → Run (idempotent).
-- After this, open the app once (or call /api/state) — default users and
-- channels bootstrap themselves on first access.

create table if not exists users (
  username      text primary key,
  name          text not null,
  role          text not null default 'team',     -- super_admin | team | client
  org           text default '',
  active        boolean not null default true,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists channels (
  id             text primary key,                -- slug, e.g. "google-ads"
  name           text not null,
  description    text default '',
  department     text default '',                 -- maps to task department for task-from-chat
  client_allowed boolean not null default false,  -- client accounts may be members
  auto_all       boolean not null default false,  -- everyone is implicitly a member (General)
  created_by     text default '',
  created_at     timestamptz not null default now()
);

create table if not exists channel_members (
  channel_id   text not null references channels(id) on delete cascade,
  username     text not null references users(username) on delete cascade,
  muted        boolean not null default false,
  last_read_ts timestamptz,
  primary key (channel_id, username)
);

create table if not exists messages (
  id         bigint generated always as identity primary key,
  channel_id text not null references channels(id) on delete cascade,
  author     text default '',                     -- display name (denormalized)
  author_id  text default '',                     -- username
  text       text default '',
  link_url   text default '',
  link_title text default '',
  task_id    text default '',                     -- set when a task was created from this message
  ts         timestamptz not null default now()
);
create index if not exists messages_channel_id_id_idx on messages(channel_id, id desc);

create table if not exists notifications (
  id         bigint generated always as identity primary key,
  username   text not null,
  kind       text default '',                     -- chat | task
  text       text default '',
  channel_id text default '',
  task_id    text default '',
  read       boolean not null default false,
  ts         timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(username, id desc);

-- links can now also live in a channel's file folder
alter table links add column if not exists channel_id text default '';

alter table users           enable row level security;
alter table channels        enable row level security;
alter table channel_members enable row level security;
alter table messages        enable row level security;
alter table notifications   enable row level security;
