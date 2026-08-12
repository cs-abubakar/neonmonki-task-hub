-- NEONMONKI Task Hub — Supabase schema
-- Run once in: Supabase Dashboard → SQL Editor → paste → Run.
-- Safe to re-run (idempotent).
--
-- Access model: the app talks to Postgres ONLY through the service role key,
-- held server-side in Vercel env vars. RLS is enabled with no anon policies,
-- so the public anon key (if ever exposed) can read/write nothing.

create table if not exists tasks (
  id              text primary key,
  title           text not null,
  date_requested  date,
  department      text default '',
  project         text default '',
  description     text default '',
  requested_by    text default '',
  owner           text default '',
  supporting      text default '',
  priority        text default 'Medium',
  status          text default 'Planned',
  evidence        text default '',
  latest_update   text default '',
  blocker         text default '',
  deliverable     text default '',
  deliverable_link text default '',
  next_action     text default '',
  due_date        text default '',
  source          text default '',
  created_at      timestamptz not null default now()
);

create table if not exists task_updates (
  id          bigint generated always as identity primary key,
  task_id     text not null references tasks(id) on delete cascade,
  ts          timestamptz not null default now(),
  author      text default '',
  text        text default '',
  status_from text,
  status_to   text
);
create index if not exists task_updates_task_id_idx on task_updates(task_id);

create table if not exists deliverables (
  id         text primary key,
  date       text default '',
  title      text not null,
  workstream text default '',
  owner      text default '',
  recipient  text default '',
  status     text default '',
  link       text default ''
);

create table if not exists decisions (
  id         text primary key,
  date       text default '',
  topic      text default '',
  rule       text not null,
  workstream text default '',
  owner      text default ''
);

create table if not exists recurring (
  id         text primary key,
  cadence    text default '',
  activity   text not null,
  department text default '',
  owner      text default '',
  reviewer   text default '',
  definition text default ''
);

create table if not exists team (
  id             bigint generated always as identity primary key,
  name           text not null,
  area           text default '',
  responsibility text default '',
  role           text default ''
);

create table if not exists links (
  id         text primary key,
  task_id    text default '',
  date       text default '',
  workstream text default '',
  title      text not null,
  url        text default '',
  type       text default '',
  owner      text default '',
  note       text default ''
);

create table if not exists activity (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null default now(),
  task_id text default '',
  author  text default '',
  text    text default ''
);
create index if not exists activity_ts_idx on activity(ts desc);

-- Lock down: RLS on, no policies → anon/authenticated keys get nothing.
-- The service role key bypasses RLS and is the only way in (server-side only).
alter table tasks         enable row level security;
alter table task_updates  enable row level security;
alter table deliverables  enable row level security;
alter table decisions     enable row level security;
alter table recurring     enable row level security;
alter table team          enable row level security;
alter table links         enable row level security;
alter table activity      enable row level security;
