-- Onboarding v2: verification codes, Google sign-in, open_to on the profile, and
-- plain-text CV uploads.

-- Google sign-in. A user who signed up with Google and never set a password
-- has password_hash null and google_sub set.
alter table users add column google_sub text;
alter table users add constraint users_google_sub_key unique (google_sub);
alter table users add constraint users_google_sub_len
    check (google_sub is null or char_length(google_sub) between 1 and 255);

-- The 6-digit code sent with the verification link. One live code per user;
-- a new send replaces the row. Only a salted SHA-256 of the code is stored.
-- attempts counts every check of this code; at 5 it is spent.
create table verification_codes (
    user_id     uuid        primary key references users (id) on delete cascade,
    code_hash   bytea       not null,
    salt        bytea       not null,
    expires_at  timestamptz not null,
    attempts    integer     not null default 0 check (attempts between 0 and 5),
    created_at  timestamptz not null default now()
);

-- An OAuth sign-in in flight, between /start and /callback. The row is found
-- by the SHA-256 of the state (the raw state lives only in the redirect and
-- in a short-lived HttpOnly cookie) and is deleted when the callback claims it.
create table oauth_states (
    state_hash     bytea       primary key,
    provider       text        not null check (provider in ('google')),
    pkce_verifier  text        not null,
    next_path      text        not null check (char_length(next_path) between 1 and 512),
    expires_at     timestamptz not null,
    created_at     timestamptz not null default now()
);

create index oauth_states_expires_at_idx on oauth_states (expires_at);

-- Profile: where the person is open to working, asked on the Targets step.
alter table profiles add column open_to text[];
alter table profiles add constraint profiles_open_to_chk
    check (open_to is null or cardinality(open_to) between 1 and 10);

alter table profiles drop constraint profiles_onboarding_step_check;
alter table profiles add constraint profiles_onboarding_step_check
    check (onboarding_step in ('upload', 'check', 'targets', 'first_job', 'done'));

-- Pasted CV text arrives as a .txt file.
alter table cv_uploads drop constraint cv_uploads_kind_check;
alter table cv_uploads add constraint cv_uploads_kind_check
    check (kind in ('pdf', 'docx', 'txt'));
