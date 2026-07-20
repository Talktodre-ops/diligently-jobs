//! ATS-friendly DOCX render via `docx-rs`.
//!
//! ATS rules baked in:
//!   - real Word paragraph styles (Heading 1, Heading 2, Normal) — no text boxes
//!   - single column, no SmartArt, no tables for layout
//!   - sans-serif Calibri throughout (overrides the design canon for ATS only)
//!   - real list bullets via numbering definitions

use anyhow::{anyhow, Context};
use docx_rs::{
    AbstractNumbering, AlignmentType, Docx, Level, LevelJc, LevelText, NumberFormat, Numbering,
    NumberingId, Paragraph, Run, RunFonts, SpecialIndentType, Start, Style, StyleType,
};

use super::resume::ResumeDoc;
use super::{ApplicationContext, CvVersionRow};

const FONT: &str = "Calibri";
const NUMBERING_ID: usize = 1;
const ABSTRACT_NUMBERING_ID: usize = 1;

/// Build a Docx pre-loaded with ATS-friendly styles + a bullet numbering def.
/// Both the flat and structured renderers start from this.
fn base_docx() -> Docx {
    let bullet_level = Level::new(
        0,
        Start::new(1),
        NumberFormat::new("bullet"),
        LevelText::new("\u{2022}"),
        LevelJc::new("left"),
    )
    .indent(Some(360), Some(SpecialIndentType::Hanging(360)), None, None);

    let abstract_numbering = AbstractNumbering::new(ABSTRACT_NUMBERING_ID).add_level(bullet_level);
    let numbering = Numbering::new(NUMBERING_ID, ABSTRACT_NUMBERING_ID);

    Docx::new()
        .add_style(
            Style::new("Heading1", StyleType::Paragraph)
                .name("Heading 1")
                .fonts(RunFonts::new().ascii(FONT))
                .size(40),
        )
        .add_style(
            Style::new("Heading2", StyleType::Paragraph)
                .name("Heading 2")
                .fonts(RunFonts::new().ascii(FONT))
                .size(24)
                .bold(),
        )
        .add_style(
            Style::new("Normal", StyleType::Paragraph)
                .name("Normal")
                .fonts(RunFonts::new().ascii(FONT))
                .size(22),
        )
        .add_abstract_numbering(abstract_numbering)
        .add_numbering(numbering)
}

fn pack(docx: Docx) -> anyhow::Result<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::<u8>::new());
    docx.build()
        .pack(&mut buf)
        .map_err(|e| anyhow!("docx pack failed: {e}"))
        .context("build docx")?;
    Ok(buf.into_inner())
}

fn bullet(text: &str) -> Paragraph {
    Paragraph::new()
        .style("Normal")
        .numbering(NumberingId::new(NUMBERING_ID), docx_rs::IndentLevel::new(0))
        .align(AlignmentType::Left)
        .add_run(Run::new().add_text(text))
}

fn heading2(text: &str) -> Paragraph {
    Paragraph::new()
        .style("Heading2")
        .add_run(Run::new().add_text(text))
}

/// ATS-friendly DOCX from a structured `ResumeDoc`. Real Word styles, single
/// column, real bullet lists — same content as the LaTeX PDF, layout tuned
/// for resume parsers rather than visual fidelity.
pub fn render_resume_doc(doc: &ResumeDoc) -> anyhow::Result<Vec<u8>> {
    let mut docx = base_docx().add_paragraph(
        Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text(&doc.header.name)),
    );

    if !doc.header.title.is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new()
                .style("Normal")
                .add_run(Run::new().add_text(&doc.header.title).italic()),
        );
    }

    // Contact line — plain text, comma-separated. ATS parsers read this fine.
    let mut contacts: Vec<String> = Vec::new();
    if let Some(e) = &doc.header.email {
        contacts.push(e.clone());
    }
    if let Some(l) = &doc.header.linkedin {
        contacts.push(l.display.clone());
    }
    if let Some(g) = &doc.header.github {
        contacts.push(g.display.clone());
    }
    if let Some(w) = &doc.header.website {
        contacts.push(w.display.clone());
    }
    if let Some(p) = &doc.header.phone {
        contacts.push(p.clone());
    }
    if !contacts.is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new()
                .style("Normal")
                .add_run(Run::new().add_text(contacts.join("  |  "))),
        );
    }

    if let Some(summary) = &doc.summary {
        if !summary.trim().is_empty() {
            docx = docx
                .add_paragraph(heading2("Professional Summary"))
                .add_paragraph(
                    Paragraph::new()
                        .style("Normal")
                        .add_run(Run::new().add_text(summary)),
                );
        }
    }

    if !doc.experience.is_empty() {
        docx = docx.add_paragraph(heading2("Experience"));
        for e in &doc.experience {
            let title = [e.role.as_str(), e.company.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(", ");
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(title).bold()),
            );
            let mut meta = format!("{} – {}", e.start, e.end);
            if let Some(loc) = &e.location {
                if !loc.is_empty() {
                    meta = format!("{meta}  |  {loc}");
                }
            }
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(meta).italic()),
            );
            for b in &e.bullets {
                docx = docx.add_paragraph(bullet(b));
            }
        }
    }

    if !doc.education.is_empty() {
        docx = docx.add_paragraph(heading2("Education"));
        for ed in &doc.education {
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(&ed.degree).bold()),
            );
            let mut meta = ed.institution.clone();
            let dates = [ed.start.as_deref(), ed.end.as_deref()]
                .iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" – ");
            if !dates.is_empty() {
                meta = format!("{meta}  |  {dates}");
            }
            if let Some(loc) = &ed.location {
                if !loc.is_empty() {
                    meta = format!("{meta}  |  {loc}");
                }
            }
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(meta).italic()),
            );
        }
    }

    if !doc.skills.is_empty() {
        docx = docx.add_paragraph(heading2("Skills"));
        for g in &doc.skills {
            // One paragraph per group: bold label run + plain items run.
            docx = docx.add_paragraph(
                Paragraph::new()
                    .style("Normal")
                    .add_run(Run::new().add_text(format!("{}: ", g.label)).bold())
                    .add_run(Run::new().add_text(g.items.join(", "))),
            );
        }
    }

    if !doc.projects.is_empty() {
        docx = docx.add_paragraph(heading2("Projects & Achievements"));
        for p in &doc.projects {
            let mut text = String::new();
            if let Some(name) = &p.name {
                if !name.is_empty() {
                    text.push_str(name);
                    text.push_str(": ");
                }
            }
            text.push_str(&p.description);
            if let Some(link) = &p.link {
                text.push_str(": ");
                text.push_str(&link.display);
            }
            docx = docx.add_paragraph(bullet(&text));
        }
    }

    pack(docx)
}

/// Legacy flat-sections DOCX. Used when `cv_versions.sections` is the old
/// `Vec<CvSection>` shape (no structured ResumeDoc).
pub fn render_cv(
    cv: &CvVersionRow,
    app: Option<&ApplicationContext>,
) -> anyhow::Result<Vec<u8>> {
    let sections = super::parse_sections(&cv.sections)?;

    let header_role = app
        .and_then(|a| a.role.as_deref())
        .unwrap_or_else(|| cv.label.as_deref().unwrap_or("Curriculum Vitae"));
    let header_company = app.and_then(|a| a.company.as_deref()).unwrap_or("");

    let mut docx = base_docx().add_paragraph(
        Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text(header_role)),
    );

    if !header_company.is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new()
                .style("Normal")
                .add_run(Run::new().add_text(header_company).italic()),
        );
    }

    for section in &sections {
        docx = docx.add_paragraph(heading2(&section.section));
        for b in &section.bullets {
            docx = docx.add_paragraph(bullet(b));
        }
    }

    pack(docx)
}

/// ATS-friendly DOCX cover letter (Phase 3, M2). Plain Normal-style
/// paragraphs — exactly what a recruiter / ATS expects from a letter.
pub fn render_cover_letter_docx(doc: &super::CoverLetterDoc) -> anyhow::Result<Vec<u8>> {
    let para = |text: &str| {
        Paragraph::new()
            .style("Normal")
            .add_run(Run::new().add_text(text))
    };

    let mut d = base_docx().add_paragraph(
        Paragraph::new()
            .style("Heading1")
            .add_run(Run::new().add_text(&doc.candidate_name)),
    );

    let push = |d: Docx, text: Option<&str>| -> Docx {
        match text {
            Some(t) if !t.trim().is_empty() => d.add_paragraph(para(t)),
            _ => d,
        }
    };

    d = push(d, doc.candidate_contact.as_deref());
    d = push(d, doc.date.as_deref());
    d = push(d, doc.company.as_deref());
    d = push(d, doc.greeting.as_deref());
    for p in &doc.paragraphs {
        if !p.trim().is_empty() {
            d = d.add_paragraph(para(p));
        }
    }
    d = push(d, doc.signoff.as_deref());
    d = d.add_paragraph(para(&doc.candidate_name));

    pack(d)
}
