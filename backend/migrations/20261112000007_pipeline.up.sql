-- The application pipeline: read the job, compare the CV, rewrite, research,
-- draft a letter. Each step's output lives in its own table so the
-- Workspace, Review, Gaps, Research and Cover letter screens read and change
-- them independently.

alter table applications
    add column source_url            text,
    add column jd_analysis           jsonb,
    add column base_cv_version_id    uuid,
    add column tailored_summary      text,
    add column summary_status        text not null default 'pending'
                                     check (summary_status in ('pending', 'accepted', 'kept')),
    add column options               jsonb not null default '{"research": true, "letter": true}'::jsonb,
    add column pipeline_job_id       uuid;
alter table applications add constraint applications_base_cv_owner_fkey
    foreign key (base_cv_version_id, user_id) references cv_versions (id, user_id)
    on delete set null (base_cv_version_id);

-- Step progress the Running screen polls through GET /v1/jobs/{id}.
alter table jobs add column progress jsonb;

-- Rewrites: what changed, why, and the user's decision.
update tailored_bullets set status = 'kept' where status = 'rejected';
alter table tailored_bullets drop constraint tailored_bullets_status_chk;
alter table tailored_bullets add constraint tailored_bullets_status_chk
    check (status in ('pending', 'accepted', 'kept', 'edited'));
alter table tailored_bullets
    add column bullet_id     text,
    add column why           text,
    add column needs_number  boolean not null default false,
    add column final_text    text,
    add column position      integer not null default 0;

-- Gaps: one row per requirement, answered one at a time.
create table application_gaps (
    id                uuid        primary key default gen_random_uuid(),
    user_id           uuid        not null,
    application_id    uuid        not null,
    position          integer     not null default 0,
    requirement       text        not null,
    importance        text        not null check (importance in ('required', 'nice_to_have')),
    status            text        not null check (status in ('covered', 'partial', 'missing')),
    evidence          text,
    ask               text,
    answer            text        check (answer in ('have', 'dont')),
    answer_text       text,
    suggested_bullet  text,
    bullet_status     text        check (bullet_status in ('pending', 'accepted', 'discarded')),
    target_entry      integer,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    foreign key (application_id, user_id) references applications (id, user_id)
        on delete cascade on update cascade
);
create index application_gaps_app_idx on application_gaps (application_id, position);
create index application_gaps_user_idx on application_gaps (user_id);
create trigger application_gaps_set_updated_at
    before update on application_gaps
    for each row execute function set_updated_at();

-- Scores: the master CV before, the projection with every rewrite, and
-- real rescoring of a tailored version.
alter table ats_scores add column kind text not null default 'rescore'
    check (kind in ('before', 'projected', 'rescore'));

alter table cover_letters add column tone text not null default 'direct'
    check (tone in ('direct', 'warm', 'formal'));
