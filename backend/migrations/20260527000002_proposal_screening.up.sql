-- Screening / follow-up question answers for an Upwork proposal (Track 20).
--
-- Upwork attaches extra screening questions at submit time. We store the
-- generated Q&A array alongside the proposal so the current (newest) proposals
-- row carries the full submission: openers + body + screening answers.
-- IF NOT EXISTS keeps this re-runnable if a prior run was killed mid-apply.
alter table proposals
    add column if not exists screening jsonb not null default '[]'::jsonb;
