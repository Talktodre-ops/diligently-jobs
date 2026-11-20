alter table cover_letters drop column if exists tone;
alter table ats_scores drop column if exists kind;
drop table if exists application_gaps;
alter table tailored_bullets
    drop column if exists bullet_id,
    drop column if exists why,
    drop column if exists needs_number,
    drop column if exists final_text,
    drop column if exists position;
alter table tailored_bullets drop constraint tailored_bullets_status_chk;
update tailored_bullets set status = 'rejected' where status in ('kept', 'edited');
alter table tailored_bullets add constraint tailored_bullets_status_chk
    check (status in ('pending', 'accepted', 'rejected'));
alter table jobs drop column if exists progress;
alter table applications drop constraint if exists applications_base_cv_owner_fkey;
alter table applications
    drop column if exists source_url,
    drop column if exists jd_analysis,
    drop column if exists base_cv_version_id,
    drop column if exists tailored_summary,
    drop column if exists summary_status,
    drop column if exists options,
    drop column if exists pipeline_job_id;
