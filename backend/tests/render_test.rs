//! Real PDF and DOCX renders through Tectonic and docx-rs.

use diligently_api::render::{docx, latex, resume::ResumeDoc};
use serde_json::json;

fn tectonic_configured() {
    let bin = std::env::var("TECTONIC_BIN")
        .expect("TECTONIC_BIN must be set; run the suite through scripts/test.sh");
    assert!(
        std::path::Path::new(&bin).exists(),
        "tectonic not found at {bin}"
    );
}

pub fn sample_doc() -> ResumeDoc {
    serde_json::from_value(json!({
        "header": {
            "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com",
            "linkedin": { "url": "https://linkedin.com/in/ada_okafor", "display": "linkedin.com/in/ada_okafor" },
            "website": { "url": r"https://x.co/}\input{/etc/hostname}", "display": "x.co" }
        },
        "summary": "Backend engineer: payments, ledgers & 99.99% uptime.",
        "experience": [{ "role": "Senior Backend Engineer", "company": "Northfold", "location": "Lagos",
                         "start": "2021", "end": "Present",
                         "bullets": ["Cut reconciliation time by 60% using Go & Postgres", r"Wrote a C\# shim {once}"] }],
        "education": [{ "institution": "University of Lagos", "degree": "B.Sc. Computer Science", "start": "2012", "end": "2016" }],
        "skills": [{ "label": "Languages", "items": ["Go", "Rust", "SQL"] }],
        "projects": [{ "name": "rate-limit", "description": "Token bucket for Go services",
                       "link": { "url": "https://github.com/ada/rate_limit", "display": "github.com/ada/rate_limit" } }]
    }))
    .unwrap()
}

#[tokio::test]
async fn cv_with_hostile_text_and_links_compiles_to_a_pdf() {
    tectonic_configured();
    let pdf = latex::render_cv(&sample_doc()).await.expect("compiles");
    assert!(pdf.starts_with(b"%PDF-"), "is a PDF");
    // The hostname file must not have been read into the document.
    let host = std::fs::read_to_string("/etc/hostname").unwrap_or_default();
    let host = host.trim();
    if !host.is_empty() {
        assert!(
            !pdf.windows(host.len()).any(|w| w == host.as_bytes()),
            "server file content leaked into the PDF"
        );
    }
}

#[test]
fn cv_renders_to_docx() {
    let bytes = docx::render_resume_doc(&sample_doc()).expect("docx");
    assert!(bytes.starts_with(b"PK"), "DOCX is a zip");
}
