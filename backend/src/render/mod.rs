//! CV / cover-letter rendering. Two formats from the same input:
//!   - PDF  via Tectonic LaTeX (Tera template `templates/cv.tex.tera`)
//!   - DOCX via `docx-rs` — ATS-friendly, real Word styles
//!
//! `jobs::handlers::cv_render` calls both, uploads each to R2, and updates
//! `cv_versions.r2_pdf_key` / `r2_docx_key`.

pub mod docx;
pub mod latex;
pub mod resume;

use serde::Deserialize;
use sqlx::FromRow;
use uuid::Uuid;

/// Just the cv_versions columns the renderer cares about.
#[derive(Debug, FromRow)]
pub struct CvVersionRow {
    pub application_id: Option<Uuid>,
    pub sections: serde_json::Value,
    pub label: Option<String>,
}

#[derive(Debug, FromRow)]
pub struct ApplicationContext {
    pub company: Option<String>,
    pub role: Option<String>,
}

/// Structured cover letter stored in `cover_letters.doc`; both renderers walk
/// this. The stored doc also carries `recipient`/`role`, ignored here as nothing
/// renders them.
#[derive(Debug, Deserialize)]
pub struct CoverLetterDoc {
    pub candidate_name: String,
    #[serde(default)]
    pub candidate_contact: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub greeting: Option<String>,
    #[serde(default)]
    pub paragraphs: Vec<String>,
    #[serde(default)]
    pub signoff: Option<String>,
}

/// Just the cover_letters columns the render handler reads.
#[derive(Debug, FromRow)]
pub struct CoverLetterRow {
    pub application_id: Uuid,
    pub doc: Option<serde_json::Value>,
}

/// Parse the `doc` jsonb into a typed CoverLetterDoc.
pub fn parse_cover_letter_doc(value: &serde_json::Value) -> anyhow::Result<CoverLetterDoc> {
    Ok(serde_json::from_value(value.clone())?)
}

/// Mirror of the desktop's CVSection shape (see diligent/src/types/job.type.ts).
/// The frontend stores an `id` per section but we don't render it.
#[derive(Debug, Deserialize)]
pub struct CvSection {
    pub section: String,
    pub bullets: Vec<String>,
}

/// Parse the jsonb sections column into a typed slice the renderers can walk.
pub fn parse_sections(value: &serde_json::Value) -> anyhow::Result<Vec<CvSection>> {
    let parsed: Vec<CvSection> = serde_json::from_value(value.clone())?;
    Ok(parsed
        .into_iter()
        .map(|s| CvSection {
            section: s.section.trim().to_string(),
            bullets: s
                .bullets
                .into_iter()
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty())
                .collect(),
        })
        .filter(|s| !s.section.is_empty() && !s.bullets.is_empty())
        .collect())
}
