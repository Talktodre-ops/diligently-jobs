-- One profile per user: what Onboarding, Profile and Settings edit.
create table profiles (
    user_id                uuid        primary key references users (id) on delete cascade,
    full_name              text,
    headline               text,
    location               text,
    target_roles           text[]      not null default '{}',
    work_settings          text[]      not null default '{}',
    paper_size             text        not null default 'a4' check (paper_size in ('a4', 'letter')),
    theme                  text        not null default 'system' check (theme in ('system', 'light', 'dark')),
    notify_follow_ups      boolean     not null default true,
    notify_interview_prep  boolean     not null default true,
    notify_product_news    boolean     not null default false,
    onboarding_step        text        not null default 'upload'
                                       check (onboarding_step in ('upload', 'check', 'targets', 'done')),
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    constraint profiles_work_settings_chk
        check (work_settings <@ array['remote', 'hybrid', 'onsite']::text[])
);

create trigger profiles_set_updated_at
    before update on profiles
    for each row execute function set_updated_at();
