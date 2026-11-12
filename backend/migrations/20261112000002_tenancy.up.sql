-- Tenancy: every user-owned row belongs to exactly one user.
--
-- Existing rows (the single-user desktop era) are assigned to a placeholder
-- owner, legacy@diligently.local, created only when there is data to own. It
-- has no password, so nobody can sign in as it. `diligently-api claim-legacy
-- --email <account>` later moves its rows to a real account.
--
-- Rows hanging off an application carry their own user_id (for direct
-- scoping, cascade on account delete, and row-level security later) and a
-- composite foreign key to applications (id, user_id), so the database itself
-- refuses a child row that points at another user's application. The keys
-- cascade on update, so moving an application to a new owner moves its
-- children with it.

do $$
begin
    if exists (select 1 from applications) or exists (select 1 from events)
       or exists (select 1 from cv_versions) or exists (select 1 from interviews)
       or exists (select 1 from chat_conversations) or exists (select 1 from jobs) then
        insert into users (email, password_hash)
        values ('legacy@diligently.local', null)
        on conflict (lower(email)) do nothing;
    end if;
end $$;

alter table events add column user_id uuid references users (id) on delete cascade;
update events set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table events alter column user_id set not null;

alter table applications add column user_id uuid references users (id) on delete cascade;
update applications set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table applications alter column user_id set not null;

alter table cv_versions add column user_id uuid references users (id) on delete cascade;
update cv_versions set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table cv_versions alter column user_id set not null;

alter table gap_analyses add column user_id uuid references users (id) on delete cascade;
update gap_analyses set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table gap_analyses alter column user_id set not null;

alter table tailored_bullets add column user_id uuid references users (id) on delete cascade;
update tailored_bullets set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table tailored_bullets alter column user_id set not null;

alter table cover_letters add column user_id uuid references users (id) on delete cascade;
update cover_letters set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table cover_letters alter column user_id set not null;

alter table interviews add column user_id uuid references users (id) on delete cascade;
update interviews set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table interviews alter column user_id set not null;

alter table chat_conversations add column user_id uuid references users (id) on delete cascade;
update chat_conversations set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table chat_conversations alter column user_id set not null;

alter table jobs add column user_id uuid references users (id) on delete cascade;
update jobs set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table jobs alter column user_id set not null;

alter table company_research add column user_id uuid references users (id) on delete cascade;
update company_research set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table company_research alter column user_id set not null;

alter table proposals add column user_id uuid references users (id) on delete cascade;
update proposals set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table proposals alter column user_id set not null;

alter table ats_scores add column user_id uuid references users (id) on delete cascade;
update ats_scores set user_id = (select id from users where email = 'legacy@diligently.local') where user_id is null;
alter table ats_scores alter column user_id set not null;

-- Composite key target for child rows.
alter table applications add constraint applications_id_user_key unique (id, user_id);

alter table gap_analyses add constraint gap_analyses_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table tailored_bullets add constraint tailored_bullets_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table cover_letters add constraint cover_letters_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table company_research add constraint company_research_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table proposals add constraint proposals_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table ats_scores add constraint ats_scores_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table cv_versions add constraint cv_versions_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table interviews add constraint interviews_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

alter table chat_conversations add constraint chat_conversations_application_owner_fkey
    foreign key (application_id, user_id) references applications (id, user_id) on delete cascade on update cascade;

-- ats_scores.cv_version_id must point at the same user's CV.
alter table cv_versions add constraint cv_versions_id_user_key unique (id, user_id);
alter table ats_scores add constraint ats_scores_cv_owner_fkey
    foreign key (cv_version_id, user_id) references cv_versions (id, user_id) on delete set null (cv_version_id) on update cascade;

-- Read paths: lists are always per user, newest first.
create index applications_user_updated_idx on applications (user_id, updated_at desc);
create index events_user_created_idx on events (user_id, created_at desc);
create index cv_versions_user_created_idx on cv_versions (user_id, created_at desc);
create index interviews_user_started_idx on interviews (user_id, started_at desc);
create index chat_conversations_user_updated_idx on chat_conversations (user_id, updated_at desc);
create index jobs_user_created_idx on jobs (user_id, created_at desc);

create index gap_analyses_user_id_idx on gap_analyses (user_id);

create index tailored_bullets_user_id_idx on tailored_bullets (user_id);

create index cover_letters_user_id_idx on cover_letters (user_id);

create index company_research_user_id_idx on company_research (user_id);

create index proposals_user_id_idx on proposals (user_id);

create index ats_scores_user_id_idx on ats_scores (user_id);
