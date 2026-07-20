-- ATS scores (the "disparity on the ATS scale").
--
-- One row per scoring run of a CV against a job's JD, produced by the async
-- `ats_score` LLM job. Newest row = current score for the application.
-- `breakdown` holds matched/missing keywords + section coverage + notes;
-- `base_score` is an optional baseline (e.g. the base CV) for the
-- before/after-tailoring delta.
create table ats_scores (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references applications(id) on delete cascade,
    cv_version_id   uuid        references cv_versions(id) on delete set null,
    score           integer     not null,
    base_score      integer,
    breakdown       jsonb       not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create index ats_scores_application_id_idx
    on ats_scores (application_id, created_at desc);
