-- Settings and email: reminder timing and writing preferences on the profile,
-- account security fields, per-purpose verification codes, Google linking,
-- unsubscribe tokens and the list of devices a user has signed in from.

-- Profile -------------------------------------------------------------------

-- Nothing ever sent interview prep emails.
alter table profiles drop column notify_interview_prep;
alter table profiles add column notify_weekly_summary boolean not null default true;
alter table profiles add column notify_running_low boolean not null default true;
-- Nobody opted in to product news on purpose.
update profiles set notify_product_news = false;

alter table profiles add column follow_up_days integer not null default 7
    check (follow_up_days in (5, 7, 10, 14));
alter table profiles add column send_hour integer not null default 9
    check (send_hour in (9, 13, 18));
-- IANA zone name; null until the browser reports one (the server then uses UTC).
alter table profiles add column time_zone text
    check (time_zone is null or char_length(time_zone) between 1 and 64);
alter table profiles add column skip_weekends boolean not null default true;
-- Null means inferred from location when needed.
alter table profiles add column spelling text
    check (spelling is null or spelling in ('en-GB', 'en-US'));
alter table profiles add column letter_tone text not null default 'direct'
    check (letter_tone in ('direct', 'warm', 'formal'));

-- The local Monday the last weekly summary went out for, and the first day of
-- the (UTC) month the last running-low email went out for. Each email is sent
-- at most once per period; the update that sets these is the claim.
alter table profiles add column weekly_summary_sent_on date;
alter table profiles add column running_low_sent_for date;

-- Users ---------------------------------------------------------------------

alter table users add column password_changed_at timestamptz;

-- Random and unguessable; it only toggles email preferences, so it is stored
-- as is and put in every optional email. 64 hex characters from two v4 UUIDs.
alter table users add column unsubscribe_token text not null
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
alter table users add constraint users_unsubscribe_token_key unique (unsubscribe_token);

-- Verification codes --------------------------------------------------------

-- One live code per user and purpose, so a delete code never replaces or
-- satisfies a sign-up code.
alter table verification_codes add column purpose text not null default 'verify'
    check (purpose in ('verify', 'delete'));
alter table verification_codes drop constraint verification_codes_pkey;
alter table verification_codes add primary key (user_id, purpose);

-- Google linking ------------------------------------------------------------

-- Set when a signed-in user starts the flow to connect Google to their account.
alter table oauth_states add column link_user_id uuid references users (id) on delete cascade;

-- Devices seen --------------------------------------------------------------

-- SHA-256 of the user-agent string (the first 300 characters, as stored on
-- sessions; empty when absent). A sign-in from a hash not listed here sends
-- the new sign-in alert.
create table known_devices (
    user_id        uuid        not null references users (id) on delete cascade,
    device_hash    bytea       not null,
    first_seen_at  timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    primary key (user_id, device_hash)
);

insert into known_devices (user_id, device_hash, first_seen_at, last_seen_at)
select user_id, sha256(convert_to(coalesce(user_agent, ''), 'UTF8')), min(created_at), max(last_seen_at)
from sessions
group by user_id, sha256(convert_to(coalesce(user_agent, ''), 'UTF8'));
