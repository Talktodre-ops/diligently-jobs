alter table cv_versions drop column if exists based_on_id;
alter table profiles drop constraint if exists profiles_master_cv_owner_fkey;
alter table profiles drop column if exists master_cv_version_id;
