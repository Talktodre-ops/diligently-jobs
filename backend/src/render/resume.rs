//! `ResumeDoc` — the canonical structured representation of a CV.
//!
//! Stored opaquely inside `cv_versions.sections` (jsonb) so no SQL migration
//! is needed when the shape evolves. The frontend parser/editor/tailor all
//! produce this shape; the LaTeX template (cv.tex.tera) consumes it.
//!
//! Legacy data: older rows hold a flat `Vec<CvSection>` (just `{section,
//! bullets}`). `parse_resume_doc` returns `None` for those; the caller
//! (job handler) falls back to rendering the static template.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeDoc {
    pub header: Header,
    /// One-paragraph professional summary. Optional — not every CV uses one.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub experience: Vec<ExperienceEntry>,
    #[serde(default)]
    pub education: Vec<EducationEntry>,
    #[serde(default)]
    pub skills: Vec<SkillGroup>,
    #[serde(default)]
    pub projects: Vec<ProjectEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub name: String,
    /// Tagline shown under the name — e.g. "AI & Machine Learning Engineer".
    pub title: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub linkedin: Option<Link>,
    #[serde(default)]
    pub github: Option<Link>,
    #[serde(default)]
    pub website: Option<Link>,
    #[serde(default)]
    pub phone: Option<String>,
}

/// A URL plus the display text that should appear in the rendered PDF.
/// `display` is what the user reads (e.g. "linkedin.com/in/janedoe"),
/// `url` is what the link target is (the full https://... form).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub url: String,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceEntry {
    pub role: String,
    pub company: String,
    #[serde(default)]
    pub location: Option<String>,
    /// Free-form date string. The template doesn't parse these — whatever
    /// the user wrote ("Oct. 2023", "Present", "2023-10", etc.) renders as-is.
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub bullets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EducationEntry {
    pub institution: String,
    #[serde(default)]
    pub location: Option<String>,
    pub degree: String,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillGroup {
    /// Section label — e.g. "AI/ML & NLP". Rendered as bold inline header.
    pub label: String,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// Bold label shown before the description — e.g. "Performance Optimization".
    /// Optional: simple bullets without a label still render.
    #[serde(default)]
    pub name: Option<String>,
    pub description: String,
    /// Optional inline link rendered as "<description>: <link.display>".
    #[serde(default)]
    pub link: Option<Link>,
}

/// Attempt to parse `cv_versions.sections` as the structured `ResumeDoc`.
/// Returns `None` when the column holds the legacy flat shape (so the
/// caller can fall back to the static-template render path).
///
/// Discriminator: a real `ResumeDoc` is a JSON object with a `header` field;
/// the legacy shape is a top-level array. We test for that before deserialising
/// to avoid noisy `serde::Error`s in the logs for the common legacy case.
pub fn parse_resume_doc(value: &serde_json::Value) -> Option<ResumeDoc> {
    if !value.is_object() {
        return None;
    }
    if value.get("header").is_none() {
        return None;
    }
    serde_json::from_value::<ResumeDoc>(value.clone()).ok()
}
