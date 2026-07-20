-- Diligently initial schema.
--
-- Design notes:
--   - `events` is the append-only spine. Every meaningful action writes a row
--     here. Other tables are projections we maintain alongside, indexed for
--     read patterns we care about (per-application views, recent activity).
--   - `applications` is the central object (one row per job we apply to).
--   - Everything that hangs off an application cascades on delete so a single
--     `delete from applications where id = ?` cleans up cleanly.
--   - We use uuid v4 for every primary key (cheap to generate client-side
--     too, lets the desktop app pre-assign ids before round-tripping).
--   - jsonb columns hold structured payloads where the shape is flexible or
--     versions independently of the table schema (event payloads, transcripts,
--     gap analyses).
--   - timestamptz everywhere; never naive timestamps.

create extension if not exists "pgcrypto";

-- =============================================================================
-- events — append-only spine
-- =============================================================================
create table events (
    id              uuid        primary key default gen_random_uuid(),
    kind            text        not null,
    payload         jsonb       not null default '{}'::jsonb,
    application_id  uuid,
    device_id       text,
    created_at      timestamptz not null default now()
);

create index events_created_at_idx
    on events (created_at desc);

create index events_kind_created_at_idx
    on events (kind, created_at desc);

create index events_application_id_created_at_idx
    on events (application_id, created_at desc)
    where application_id is not null;

create index events_payload_gin
    on events using gin (payload);

-- =============================================================================
-- applications — projection (one row per job application)
-- =============================================================================
create table applications (
    id            uuid        primary key default gen_random_uuid(),
    company       text,
    role          text,
    jd_raw        text        not null,
    requirements  jsonb,
    status        text        not null default 'draft',
    submitted_at  timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- Common read patterns
create index applications_updated_at_idx on applications (updated_at desc);
create index applications_status_idx     on applications (status);

-- =============================================================================
-- cv_versions — immutable CV snapshots
-- =============================================================================
-- application_id NULL = base CV. Each accepted-bullet round produces a new row.
create table cv_versions (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        references applications(id) on delete cascade,
    sections        jsonb       not null,
    r2_blob_key     text,
    label           text,
    created_at      timestamptz not null default now()
);

create index cv_versions_application_id_idx
    on cv_versions (application_id, created_at desc);

-- =============================================================================
-- gap_analyses — JD-vs-CV diff snapshots
-- =============================================================================
create table gap_analyses (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references applications(id) on delete cascade,
    requirements    jsonb       not null,
    gaps            jsonb       not null,
    created_at      timestamptz not null default now()
);

create index gap_analyses_application_id_idx
    on gap_analyses (application_id, created_at desc);

-- =============================================================================
-- tailored_bullets — per-bullet rewrites + accept/reject decisions
-- =============================================================================
create table tailored_bullets (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references applications(id) on delete cascade,
    section         text        not null,
    original        text        not null,
    rewrite         text        not null,
    status          text        not null default 'pending',
    decided_at      timestamptz,
    created_at      timestamptz not null default now(),
    constraint tailored_bullets_status_chk
        check (status in ('pending', 'accepted', 'rejected'))
);

create index tailored_bullets_application_id_status_idx
    on tailored_bullets (application_id, status);

-- =============================================================================
-- cover_letters — generated letters with optional R2-rendered PDF
-- =============================================================================
create table cover_letters (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references applications(id) on delete cascade,
    body            text        not null,
    sources         jsonb       not null default '[]'::jsonb,
    r2_blob_key     text,
    generated_at    timestamptz not null default now()
);

create index cover_letters_application_id_idx
    on cover_letters (application_id, generated_at desc);

-- =============================================================================
-- interviews — live capture sessions
-- =============================================================================
-- transcript is an array of {ts, kind:"interim"|"final", text} objects.
-- ai_messages is an array of completions served during the session.
create table interviews (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        references applications(id) on delete cascade,
    started_at      timestamptz not null default now(),
    ended_at        timestamptz,
    transcript      jsonb       not null default '[]'::jsonb,
    ai_messages     jsonb       not null default '[]'::jsonb,
    r2_audio_key    text,
    notes           text,
    created_at      timestamptz not null default now()
);

create index interviews_application_id_started_at_idx
    on interviews (application_id, started_at desc)
    where application_id is not null;

create index interviews_started_at_idx
    on interviews (started_at desc);

-- =============================================================================
-- chat_conversations — sync target for the desktop "chat history"
-- =============================================================================
create table chat_conversations (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        references applications(id) on delete cascade,
    title           text,
    messages        jsonb       not null default '[]'::jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index chat_conversations_updated_at_idx
    on chat_conversations (updated_at desc);

create index chat_conversations_application_id_idx
    on chat_conversations (application_id, updated_at desc)
    where application_id is not null;

-- =============================================================================
-- updated_at trigger — applies to anything with a mutable updated_at column
-- =============================================================================
create or replace function set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger applications_set_updated_at
    before update on applications
    for each row execute function set_updated_at();

create trigger chat_conversations_set_updated_at
    before update on chat_conversations
    for each row execute function set_updated_at();
