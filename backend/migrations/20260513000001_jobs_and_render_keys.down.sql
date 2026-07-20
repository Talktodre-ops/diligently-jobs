alter table cover_letters drop column if exists r2_docx_key;
alter table cover_letters drop column if exists r2_pdf_key;

alter table cv_versions drop column if exists r2_docx_key;
alter table cv_versions drop column if exists r2_pdf_key;

drop trigger if exists jobs_set_updated_at on jobs;
drop table if exists jobs;
