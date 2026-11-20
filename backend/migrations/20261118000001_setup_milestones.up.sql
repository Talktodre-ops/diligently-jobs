-- Setup as milestones: onboarding can be skipped and finished later from Home.

-- When the user confirmed what was read from their CV (the "check" milestone).
alter table profiles add column cv_checked_at timestamptz;
-- Until when the Home setup card stays hidden after the user tucks it away.
alter table profiles add column setup_hidden_until timestamptz;

-- Everyone already past the check step has done it.
update profiles set cv_checked_at = updated_at
where onboarding_step in ('targets', 'first_job', 'done');
