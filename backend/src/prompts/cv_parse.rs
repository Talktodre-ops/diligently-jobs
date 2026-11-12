//! Turn an uploaded CV (PDF, or text extracted from DOCX) into a ResumeDoc.
//! Ported from the desktop app's parse prompt: verbatim content, nulls for
//! anything missing, nothing invented.

use serde_json::Value;

use super::{array, nullable, object, string};
use crate::ai::LlmRequest;
use crate::render::resume::{self, ResumeDoc};

pub const TASK: &str = "cv_parse";

pub const SYSTEM: &str = "You convert a CV into structured data for a CV builder.

Rules:
- Copy bullets, the summary and project descriptions word for word. Do not paraphrase, shorten, improve or translate.
- Never invent anything: no employers, dates, metrics, links or skills that are not in the CV. Use null when a field is missing, and an empty string for a missing start or end date.
- Strip bullet symbols and leading whitespace from each bullet.
- header.title is the line under the name, or the most recent job title when there is none.
- Links need both url (full https:// form) and display (the short form a reader sees). Derive one from the other when only one appears.
- Keep experience in the order the CV uses.
- skills: one entry per group the CV uses; split items on commas. If the CV has a flat list, use a single group labelled \"Skills\".
- projects: a bold label before a colon is the name; otherwise name is null and the whole line is the description.";

fn link() -> Value {
    nullable(object(&[("url", string()), ("display", string())]))
}

pub fn schema() -> Value {
    object(&[
        (
            "header",
            object(&[
                ("name", string()),
                ("title", string()),
                ("email", nullable(string())),
                ("phone", nullable(string())),
                ("linkedin", link()),
                ("github", link()),
                ("website", link()),
            ]),
        ),
        ("summary", nullable(string())),
        (
            "experience",
            array(object(&[
                ("role", string()),
                ("company", string()),
                ("location", nullable(string())),
                ("start", string()),
                ("end", string()),
                ("bullets", array(string())),
            ])),
        ),
        (
            "education",
            array(object(&[
                ("institution", string()),
                ("location", nullable(string())),
                ("degree", string()),
                ("start", nullable(string())),
                ("end", nullable(string())),
            ])),
        ),
        (
            "skills",
            array(object(&[("label", string()), ("items", array(string()))])),
        ),
        (
            "projects",
            array(object(&[
                ("name", nullable(string())),
                ("description", string()),
                ("link", link()),
            ])),
        ),
    ])
}

pub enum Source {
    Pdf { base64: String },
    Text(String),
}

pub fn request(source: Source) -> LlmRequest {
    let (pdf_base64, user_text) = match source {
        Source::Pdf { base64 } => (Some(base64), "Convert the attached CV.".to_string()),
        Source::Text(t) => (None, format!("Convert this CV:\n\n<cv>\n{t}\n</cv>")),
    };
    LlmRequest {
        task: TASK,
        system: SYSTEM.to_string(),
        user_text,
        pdf_base64,
        schema: schema(),
        max_tokens: 16_000,
        effort: "low",
    }
}

/// Parse the model's answer and fit it within the CV limits.
pub fn parse(value: Value) -> Result<ResumeDoc, String> {
    let mut doc: ResumeDoc = serde_json::from_value(value)
        .map_err(|e| format!("answer did not match the CV shape: {e}"))?;
    resume::clamp(&mut doc);
    if doc.header.name.trim().is_empty() {
        return Err("no name found; this may not be a CV".into());
    }
    resume::validate(&doc)?;
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_is_valid_for_structured_outputs() {
        assert!(super::super::all_objects_closed(&schema()));
    }

    #[test]
    fn parse_clamps_and_drops_unsafe_links() {
        let doc = parse(json!({
            "header": { "name": "Ada Okafor", "title": "Engineer", "email": null, "phone": null,
                        "linkedin": { "url": "javascript:x", "display": "x" }, "github": null, "website": null },
            "summary": null,
            "experience": [{ "role": "Eng", "company": "N", "location": null, "start": "", "end": "",
                             "bullets": ["x".repeat(900)] }],
            "education": [], "skills": [], "projects": []
        }))
        .unwrap();
        assert!(
            doc.header.linkedin.is_none(),
            "unsafe link removed rather than failing the upload"
        );
        assert_eq!(doc.experience[0].bullets[0].chars().count(), 600);
    }

    #[test]
    fn parse_refuses_a_document_without_a_name() {
        let v = json!({
            "header": { "name": " ", "title": "", "email": null, "phone": null, "linkedin": null, "github": null, "website": null },
            "summary": null, "experience": [], "education": [], "skills": [], "projects": []
        });
        assert!(parse(v).is_err());
    }
}
