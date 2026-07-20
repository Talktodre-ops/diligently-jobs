-- Cover letter rendering support (Phase 3, M2).
--
-- The base `cover_letters` table (initial schema) stored just `body` + a single
-- `r2_blob_key`. Add the structured doc (for re-rendering) and separate PDF/DOCX
-- render keys, mirroring how cv_versions tracks both formats.
-- IF NOT EXISTS keeps this re-runnable: a prior run may have added the columns
-- but been killed before sqlx recorded the migration, so it retries this file.
alter table cover_letters
    add column if not exists doc          jsonb,
    add column if not exists r2_pdf_key   text,
    add column if not exists r2_docx_key  text;
