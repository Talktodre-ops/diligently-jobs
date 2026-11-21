//! Real PDF and DOCX renders through Tectonic and docx-rs.

use diligently_api::render::{docx, latex, resume::ResumeDoc, Paper};
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
    let pdf = latex::render_cv(&sample_doc(), Paper::A4)
        .await
        .expect("compiles");
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
    let bytes = docx::render_resume_doc(&sample_doc(), Paper::A4).expect("docx");
    assert!(bytes.starts_with(b"PK"), "DOCX is a zip");
}

/// Page size in points of the first page, following /Parent for an
/// inherited MediaBox.
fn page_size_pt(pdf: &[u8]) -> (f32, f32) {
    let doc = lopdf::Document::load_mem(pdf).expect("parse PDF");
    let first = *doc.get_pages().values().next().expect("one page");
    let mut dict = doc.get_dictionary(first).unwrap();
    loop {
        if let Ok(mb) = dict.get(b"MediaBox") {
            let v = match mb {
                lopdf::Object::Array(a) => a.clone(),
                lopdf::Object::Reference(id) => {
                    doc.get_object(*id).unwrap().as_array().unwrap().clone()
                }
                other => panic!("unexpected MediaBox {other:?}"),
            };
            let n: Vec<f32> = v.iter().map(|o| o.as_float().unwrap()).collect();
            return (n[2] - n[0], n[3] - n[1]);
        }
        let parent = dict.get(b"Parent").unwrap().as_reference().unwrap();
        dict = doc.get_dictionary(parent).unwrap();
    }
}

#[tokio::test]
async fn pdf_page_size_follows_the_paper_preference() {
    tectonic_configured();
    let (w, h) = page_size_pt(&latex::render_cv(&sample_doc(), Paper::A4).await.unwrap());
    assert!(
        (w - 595.28).abs() < 1.0 && (h - 841.89).abs() < 1.0,
        "A4 was {w} x {h}"
    );
    let (w, h) = page_size_pt(
        &latex::render_cv(&sample_doc(), Paper::Letter)
            .await
            .unwrap(),
    );
    assert!(
        (w - 612.0).abs() < 1.0 && (h - 792.0).abs() < 1.0,
        "Letter was {w} x {h}"
    );
}

fn docx_page(bytes: Vec<u8>) -> String {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("docx is a zip");
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .expect("document.xml")
        .read_to_string(&mut xml)
        .unwrap();
    let i = xml.find("<w:pgSz").expect("page size element");
    xml[i..i + xml[i..].find("/>").unwrap()].to_string()
}

#[test]
fn docx_page_size_follows_the_paper_preference() {
    let a4 = docx_page(docx::render_resume_doc(&sample_doc(), Paper::A4).unwrap());
    assert!(
        a4.contains(r#"w:w="11906""#) && a4.contains(r#"w:h="16838""#),
        "{a4}"
    );
    let letter = docx_page(docx::render_resume_doc(&sample_doc(), Paper::Letter).unwrap());
    assert!(
        letter.contains(r#"w:w="12240""#) && letter.contains(r#"w:h="15840""#),
        "{letter}"
    );
}
