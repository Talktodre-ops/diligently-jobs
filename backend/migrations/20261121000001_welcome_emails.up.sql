-- One-time emails: a welcome once the address is confirmed, and a note when
-- the first tailored CV is ready. Each timestamp is claimed before sending,
-- so neither email can go out twice.
alter table users add column welcomed_at timestamptz;
alter table users add column first_cv_mailed_at timestamptz;

-- People who joined before these emails existed don't get them late.
update users set welcomed_at = now() where email_verified_at is not null;
update users set first_cv_mailed_at = now()
where exists (select 1 from applications a where a.user_id = users.id);
