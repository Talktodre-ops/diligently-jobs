alter table cover_letters
    drop column if exists doc,
    drop column if exists r2_pdf_key,
    drop column if exists r2_docx_key;
