-- Tracking after the application goes out: stages, follow-up reminders and
-- follow-up drafts.

alter table applications add column stage text not null default 'saved'
    check (stage in ('saved', 'applied', 'interviewing', 'offer', 'closed'));
update applications set stage = 'applied' where submitted_at is not null;
create index applications_user_stage_idx on applications (user_id, stage, updated_at desc);

create table reminders (
    id              uuid        primary key default gen_random_uuid(),
    user_id         uuid        not null,
    application_id  uuid        not null,
    due_at          timestamptz not null,
    status          text        not null default 'scheduled'
                                check (status in ('scheduled', 'sending', 'sent', 'done', 'cancelled', 'failed')),
    attempts        integer     not null default 0,
    sent_at         timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    foreign key (application_id, user_id) references applications (id, user_id)
        on delete cascade on update cascade
);
-- The sweep reads only due, scheduled rows.
create index reminders_due_idx on reminders (due_at) where status = 'scheduled';
create index reminders_app_idx on reminders (application_id);
create index reminders_user_idx on reminders (user_id, due_at);
create trigger reminders_set_updated_at
    before update on reminders
    for each row execute function set_updated_at();

create table follow_ups (
    id              uuid        primary key default gen_random_uuid(),
    user_id         uuid        not null,
    application_id  uuid        not null,
    channel         text        not null check (channel in ('email', 'linkedin')),
    subject         text,
    body            text        not null,
    created_at      timestamptz not null default now(),
    foreign key (application_id, user_id) references applications (id, user_id)
        on delete cascade on update cascade
);
create index follow_ups_app_idx on follow_ups (application_id, channel, created_at desc);
create index follow_ups_user_idx on follow_ups (user_id);
