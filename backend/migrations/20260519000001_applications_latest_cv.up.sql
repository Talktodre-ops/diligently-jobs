-- Mirror the latest rendered CV's R2 keys + pointer onto applications so the
-- "application bundle" (Job + JD + CV) is reachable in a single row.
--
-- cv_versions remains the immutable history; this is the latest pointer.
-- Updated by jobs::handlers::cv_render whenever a render completes for a CV
-- that is tied to an application.

alter table applications add column latest_cv_version_id  uuid references cv_versions(id) on delete set null;
alter table applications add column latest_cv_pdf_key     text;
alter table applications add column latest_cv_docx_key    text;
alter table applications add column latest_cv_rendered_at timestamptz;
