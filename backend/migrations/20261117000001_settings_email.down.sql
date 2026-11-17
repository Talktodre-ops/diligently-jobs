drop table if exists known_devices;

alter table oauth_states drop column link_user_id;

-- Only sign-up codes existed before; delete codes go.
delete from verification_codes where purpose <> 'verify';
alter table verification_codes drop constraint verification_codes_pkey;
alter table verification_codes drop column purpose;
alter table verification_codes add primary key (user_id);

alter table users drop constraint users_unsubscribe_token_key;
alter table users drop column unsubscribe_token;
alter table users drop column password_changed_at;

alter table profiles drop column running_low_sent_for;
alter table profiles drop column weekly_summary_sent_on;
alter table profiles drop column letter_tone;
alter table profiles drop column spelling;
alter table profiles drop column skip_weekends;
alter table profiles drop column time_zone;
alter table profiles drop column send_hour;
alter table profiles drop column follow_up_days;
alter table profiles drop column notify_running_low;
alter table profiles drop column notify_weekly_summary;
alter table profiles add column notify_interview_prep boolean not null default true;
