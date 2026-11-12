-- The master CV is a pointer to an immutable cv_versions row. Editing it
-- writes a new version and moves the pointer, so CVs already tailored or
-- sent from an older version never change underneath the user.
alter table profiles add column master_cv_version_id uuid;
alter table profiles add constraint profiles_master_cv_owner_fkey
    foreign key (master_cv_version_id, user_id) references cv_versions (id, user_id)
    on delete set null (master_cv_version_id);

-- Which version a tailored CV started from.
alter table cv_versions add column based_on_id uuid references cv_versions (id) on delete set null;
