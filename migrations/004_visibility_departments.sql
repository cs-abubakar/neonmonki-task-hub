-- NEONMONKI Task Hub — migration 004: task visibility + departments
-- Run after 003 in the Supabase SQL Editor (idempotent).
--
-- visibility:
--   'shared'   — client + team (default; current behavior)
--   'internal' — Advertidea team + super admin only (never sent to the client)
--   'private'  — only the creator, the person in private_for, and super admin
-- assigned_department: a task can target a department instead of one person.

alter table tasks add column if not exists visibility text not null default 'shared';
alter table tasks add column if not exists private_for text default '';
alter table tasks add column if not exists assigned_department text default '';

-- users gain department membership (drives department assignment + My Work)
alter table users add column if not exists departments jsonb not null default '[]';

update users set departments = '["Project Management","Paid Marketing","Conversion Tracking","Data Analytics"]' where username = 'abubakar';
update users set departments = '["Project Management"]' where username = 'hafeez';
update users set departments = '["Project Management"]' where username = 'areeb';
update users set departments = '["Paid Marketing","Conversion Tracking","Data Analytics"]' where username = 'taha';
update users set departments = '["SEO - Technical"]' where username = 'usama';
update users set departments = '["SEO - Content","SEO - Research"]' where username = 'sana';
update users set departments = '["Email Marketing"]' where username = 'munsif';
update users set departments = '["Development"]' where username = 'mateen';
update users set departments = '["AI & Automation"]' where username = 'taimoor';

-- hiring / candidate-evaluation tasks are internal by nature
update tasks set visibility = 'internal'
where id in ('NM-PM-003','NM-AI-001','NM-AI-002','NM-AI-003','NM-AI-004');
