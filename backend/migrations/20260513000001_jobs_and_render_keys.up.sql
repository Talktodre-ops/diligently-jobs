-- Async jobs queue + cv_versions render keys.
--
-- Why a jobs table at all: the desktop app shouldn't block on slow side
-- effects (PDF/DOCX render, R2 upload). API endpoints enqueue a row here and
-- return immediately with the job id; the in-process worker (src/jobs/worker.rs)
-- claims rows via FOR UPDATE SKIP LOCKED, runs them, marks done/failed with
-- exponential backoff retries.
--
-- Status lifecycle: queued -> running -> (done | failed)
--   running rows that crash mid-flight are recovered by the worker on boot
--   (any row stuck in 'running' for > 5 min gets reset to 'queued').

create table jobs (
    id              uuid        primary key default gen_random_uuid(),
    kind            text        not null,
    payload         jsonb       not null default '{}'::jsonb,
    status          text        not null default 'queued',
    result          jsonb,
    attempts        integer     not null default 0,
    max_attempts    integer     not null default 3,
    last_error      text,
    scheduled_at    timestamptz not null default now(),
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint jobs_status_chk
        check (status in ('queued', 'running', 'done', 'failed'))
);

-- Worker poll: pick the oldest queued (or backed-off) job whose scheduled_at has passed.
create index jobs_pickup_idx
    on jobs (scheduled_at)
    where status = 'queued';

-- Stuck-job recovery on boot.
create index jobs_running_started_at_idx
    on jobs (started_at)
    where status = 'running';

-- Per-kind history for debugging / dashboards.
create index jobs_kind_created_at_idx
    on jobs (kind, created_at desc);

create trigger jobs_set_updated_at
    before update on jobs
    for each row execute function set_updated_at();

-- =============================================================================
-- cv_versions: split out per-format R2 keys.
-- The legacy r2_blob_key column stays around (Track 9 still writes it as the
-- source-upload key); the render pipeline uses the new typed columns.
-- =============================================================================
alter table cv_versions add column r2_pdf_key  text;
alter table cv_versions add column r2_docx_key text;

-- Mirror split for cover_letters so Track 11 inherits the same shape for free.
alter table cover_letters add column r2_pdf_key  text;
alter table cover_letters add column r2_docx_key text;
