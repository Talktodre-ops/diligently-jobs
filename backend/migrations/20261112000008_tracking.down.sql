drop table if exists follow_ups;
drop table if exists reminders;
drop index if exists applications_user_stage_idx;
alter table applications drop column if exists stage;
