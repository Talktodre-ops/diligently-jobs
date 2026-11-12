-- Accounts: users, server-side sessions, and single-use email tokens.
--
-- Emails are stored normalised (trimmed, lower-cased) by the application and
-- the unique index is on lower(email) as a second line of defence.
-- Session and email tokens are random 32-byte values; only their SHA-256 is
-- stored, so a database leak does not hand out working sessions or links.

create table users (
    id                 uuid        primary key default gen_random_uuid(),
    email              text        not null,
    -- Null only for the legacy owner created by the tenancy migration, which
    -- can never sign in until its data is claimed by a real account.
    password_hash      text,
    email_verified_at  timestamptz,
    plan               text        not null default 'free',
    last_sign_in_at    timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    constraint users_email_len check (char_length(email) between 3 and 254)
);

create unique index users_email_lower_key on users (lower(email));

create trigger users_set_updated_at
    before update on users
    for each row execute function set_updated_at();

create table sessions (
    id                   uuid        primary key default gen_random_uuid(),
    user_id              uuid        not null references users (id) on delete cascade,
    token_hash           bytea       not null unique,
    user_agent           text,
    ip                   text,
    created_at           timestamptz not null default now(),
    last_seen_at         timestamptz not null default now(),
    -- Sliding expiry, pushed forward on use, never past absolute_expires_at.
    expires_at           timestamptz not null,
    absolute_expires_at  timestamptz not null
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table email_tokens (
    id          uuid        primary key default gen_random_uuid(),
    user_id     uuid        not null references users (id) on delete cascade,
    purpose     text        not null check (purpose in ('verify', 'reset', 'change_email')),
    token_hash  bytea       not null unique,
    -- Target address for a change_email token.
    new_email   text,
    expires_at  timestamptz not null,
    used_at     timestamptz,
    created_at  timestamptz not null default now()
);

create index email_tokens_user_purpose_idx on email_tokens (user_id, purpose, created_at desc);
