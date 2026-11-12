-- An uploaded CV file and the state of turning it into the master CV.
create table cv_uploads (
    id             uuid        primary key default gen_random_uuid(),
    user_id        uuid        not null references users (id) on delete cascade,
    filename       text        not null,
    kind           text        not null check (kind in ('pdf', 'docx')),
    size_bytes     integer     not null,
    storage_key    text        not null,
    status         text        not null default 'queued'
                               check (status in ('queued', 'reading', 'done', 'failed')),
    error          text,
    cv_version_id  uuid,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    constraint cv_uploads_cv_owner_fkey foreign key (cv_version_id, user_id)
        references cv_versions (id, user_id) on delete set null (cv_version_id)
);

create index cv_uploads_user_created_idx on cv_uploads (user_id, created_at desc);

create trigger cv_uploads_set_updated_at
    before update on cv_uploads
    for each row execute function set_updated_at();
