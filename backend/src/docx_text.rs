//! Plain text from a .docx (a zip holding word/document.xml). Paragraphs and
//! line breaks become newlines; everything else that is not text is dropped.
//! Reads are bounded so a zip bomb cannot exhaust memory.

use std::io::{Cursor, Read};

/// Upper bound on the decompressed document.xml we will read.
const MAX_XML_BYTES: u64 = 20 * 1024 * 1024;

pub fn is_docx(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"PK\x03\x04") {
        return false;
    }
    zip::ZipArchive::new(Cursor::new(bytes))
        .map(|mut z| z.by_name("word/document.xml").is_ok())
        .unwrap_or(false)
}

pub fn extract(bytes: &[u8]) -> anyhow::Result<String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    let entry = zip.by_name("word/document.xml")?;
    let mut xml = String::new();
    entry.take(MAX_XML_BYTES + 1).read_to_string(&mut xml)?;
    if xml.len() as u64 > MAX_XML_BYTES {
        anyhow::bail!("document is too large to read");
    }
    Ok(xml_to_text(&xml))
}

fn xml_to_text(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 4);
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        out.push_str(&unescape(&rest[..lt]));
        let Some(gt) = rest[lt..].find('>') else {
            break;
        };
        let tag = &rest[lt + 1..lt + gt];
        let name = tag
            .trim_start_matches('/')
            .split([' ', '/'])
            .next()
            .unwrap_or("");
        match name {
            "w:p" if tag.starts_with('/') => out.push('\n'),
            "w:br" | "w:cr" => out.push('\n'),
            "w:tab" => out.push('\t'),
            _ => {}
        }
        rest = &rest[lt + gt + 1..];
    }
    // Collapse runs of blank lines left by empty paragraphs.
    let mut cleaned = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        cleaned.push_str(line.trim_end());
        cleaned.push('\n');
    }
    cleaned.trim().to_string()
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_breaks_and_entities() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Ada Okafor</w:t></w:r></w:p><w:p></w:p><w:p></w:p><w:p><w:r><w:t xml:space="preserve">Go &amp; Rust</w:t><w:br/><w:t>Lagos</w:t></w:r></w:p></w:body></w:document>"#;
        assert_eq!(xml_to_text(xml), "Ada Okafor\n\nGo & Rust\nLagos");
    }

    #[test]
    fn real_docx_round_trip() {
        let doc: crate::render::resume::ResumeDoc = serde_json::from_value(serde_json::json!({
            "header": { "name": "Ada Okafor", "title": "Backend Engineer" },
            "experience": [{ "role": "Engineer", "company": "Northfold", "start": "2021", "end": "Now", "bullets": ["Built a ledger"] }]
        }))
        .unwrap();
        let bytes = crate::render::docx::render_resume_doc(&doc, crate::render::Paper::A4).unwrap();
        assert!(is_docx(&bytes));
        let text = extract(&bytes).unwrap();
        assert!(
            text.contains("Ada Okafor") && text.contains("Built a ledger"),
            "{text}"
        );
        assert!(!is_docx(b"PK\x03\x04not really a zip"));
        assert!(!is_docx(b"%PDF-1.7"));
    }
}
