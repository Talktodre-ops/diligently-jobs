-- Rows that only the newer code could write are mapped back so the older
-- checks hold again: txt uploads are removed (their master CV stays), and a
-- first_job step goes back to targets.
delete from cv_uploads where kind = 'txt';
alter table cv_uploads drop constraint cv_uploads_kind_check;
alter table cv_uploads add constraint cv_uploads_kind_check
    check (kind in ('pdf', 'docx'));

update profiles set onboarding_step = 'targets' where onboarding_step = 'first_job';
alter table profiles drop constraint profiles_onboarding_step_check;
alter table profiles add constraint profiles_onboarding_step_check
    check (onboarding_step in ('upload', 'check', 'targets', 'done'));

alter table profiles drop constraint profiles_open_to_chk;
alter table profiles drop column open_to;

drop table if exists oauth_states;
drop table if exists verification_codes;

alter table users drop constraint users_google_sub_len;
alter table users drop constraint users_google_sub_key;
alter table users drop column google_sub;
