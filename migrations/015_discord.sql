-- NEONMONKI Task Hub — migration 015: Discord notification layer
-- Run after 014 in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Discord = the real-time notification layer; the Task Hub database stays the
-- source of truth. Three pieces:
--
--   users.discord_user_id   — each person's Discord snowflake ID, used to build
--                             real <@id> mentions (admin-managed, optional).
--   clients.discord_*       — per-board Discord routing. Boards are the client
--                             registry (NEONMONKI today, more later): each board
--                             can point at its own Discord channel, so adding a
--                             board never needs a code change.
--   discord_log             — delivery audit + dedupe. The unique event_key
--                             makes the daily overdue sweep notify once per
--                             task/person/due-date, and records failures for
--                             admin diagnostics.
--
-- The Discord bot token lives in integration_connections (id "discord"),
-- encrypted server-side like every other connector credential — it is never
-- selectable through the public integration read path.
--
-- Same lock-down as every other table: RLS on, no policies; only the
-- service role key can read or write.

alter table users add column if not exists discord_user_id text not null default '';

alter table clients add column if not exists discord_channel_id text not null default '';
alter table clients add column if not exists discord_enabled boolean not null default true;

-- The default board must physically exist so its Discord channel is editable.
insert into clients (id, name)
values ('neonmonki', 'NEONMONKI')
on conflict (id) do nothing;

create table if not exists discord_log (
  id              bigint generated always as identity primary key,
  event_key       text not null unique,     -- dedupe: e.g. overdue:NM-…:user:2026-08-31
  kind            text not null default '', -- assigned | mention | comment | overdue | test
  username        text not null default '',
  discord_user_id text not null default '',
  task_id         text not null default '',
  board_id        text not null default '',
  channel_id      text not null default '',
  status          text not null default 'sent',  -- sent | failed | skipped
  error           text not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists discord_log_created_idx on discord_log(created_at desc);
create index if not exists discord_log_task_idx on discord_log(task_id);

alter table discord_log enable row level security;  -- no policies: service-role only
