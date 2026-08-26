-- NEONMONKI Task Hub — migration 013: AI interaction answers
-- Run after 012 in the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- The AI audit log already records who asked what, when, with which tools and
-- what it cost. The Control Panel's AI History view also shows the exact
-- user-visible answer Monki gave, so the super admin can review any user's AI
-- conversation by date. Answers are stored trimmed (4 KB) — the audit row
-- remains a review record, not a transcript of model internals.

alter table ai_audit add column if not exists answer text not null default '';
