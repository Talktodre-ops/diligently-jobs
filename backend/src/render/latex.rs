//! LaTeX render path — compiles a .tex source via the Tectonic CLI subprocess
//! and returns the resulting PDF bytes.
//!
//! Structured `ResumeDoc` rows render through the Tera template
//! (`templates/cv.tex.tera`, the user's canonical layout); legacy flat
//! `Vec<CvSection>` rows render through `render_flat_cv`, which rebuilds a
//! consistent layout from the actual section content plus the candidate
//! header pulled from the latest structured base CV.

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::process::Command;

use super::resume::{Header, ResumeDoc};
use super::Paper;

/// Tera-templated CV, driven by `ResumeDoc`.
///
/// (`templates/cv.tex` is no longer compiled in, but keep the file — the
/// Dockerfile builds it at image time to prewarm Tectonic's package cache.)
pub const TEMPLATE_CV_TERA: &str = include_str!("../../templates/cv.tex.tera");

/// Override path to the tectonic binary via env. Defaults to `tectonic` on PATH.
fn tectonic_bin() -> String {
    std::env::var("TECTONIC_BIN").unwrap_or_else(|_| "tectonic".to_string())
}

/// Run `tectonic --version` once at startup so a misconfigured TECTONIC_BIN
/// shows up as a clear log line instead of "spawn failed" on every render job.
pub async fn probe_tectonic() -> Result<String> {
    let bin = tectonic_bin();
    let output = Command::new(&bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("spawn tectonic ({bin})"))?;
    if !output.status.success() {
        return Err(anyhow!(
            "tectonic --version exited {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    Ok(format!("{} [{}]", line, bin))
}

/// Render flat `Vec<CvSection>` rows to PDF. The candidate header (name +
/// contacts) is taken from the latest structured base CV, since flat sections
/// carry none. Fallback for rows that aren't a structured `ResumeDoc`.
pub async fn render_flat_cv(
    sections: &serde_json::Value,
    app: Option<&super::ApplicationContext>,
    base_header: Option<&Header>,
    paper: Paper,
) -> Result<Vec<u8>> {
    render_tex(&build_flat_cv_tex(sections, app, base_header, paper)?).await
}

/// Icon contact line (email, linkedin, github, website, phone), styled to
/// match the templated header. URLs through `tex_url`, display text through
/// `tex_escape`.
fn flat_contact_line(h: &Header) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(e) = h.email.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!(
            "\\href{{mailto:{}}}{{\\raisebox{{-0.2\\height}}\\faEnvelope\\  \\underline{{{}}}}}",
            tex_url(e),
            tex_escape(e)
        ));
    }
    if let Some(l) = &h.linkedin {
        parts.push(format!(
            "\\href{{{}}}{{\\raisebox{{-0.2\\height}}\\faLinkedin\\ \\underline{{{}}}}}",
            tex_url(&l.url),
            tex_escape(&l.display)
        ));
    }
    if let Some(g) = &h.github {
        parts.push(format!(
            "\\href{{{}}}{{\\raisebox{{-0.2\\height}}\\faGithub\\ \\underline{{{}}}}}",
            tex_url(&g.url),
            tex_escape(&g.display)
        ));
    }
    if let Some(w) = &h.website {
        parts.push(format!(
            "\\href{{{}}}{{\\raisebox{{-0.2\\height}}\\faGlobe\\ \\underline{{{}}}}}",
            tex_url(&w.url),
            tex_escape(&w.display)
        ));
    }
    if let Some(p) = h.phone.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!(
            "\\raisebox{{-0.2\\height}}\\faPhone\\  {}",
            tex_escape(p)
        ));
    }
    parts.join(" ~ ")
}

/// Assemble the `.tex` for flat sections: candidate header (name + contacts +
/// target role) over one itemized list per section, styled like the templated
/// path. Every interpolated value is `tex_escape`d. The application's company
/// (the employer applied TO) is intentionally omitted from the header.
fn build_flat_cv_tex(
    sections_json: &serde_json::Value,
    app: Option<&super::ApplicationContext>,
    base_header: Option<&Header>,
    paper: Paper,
) -> Result<String> {
    let sections = super::parse_sections(sections_json).context("parse flat sections")?;

    // Title = the role being targeted (from the application), falling back to
    // the base CV's own title, then a generic label.
    let title = app
        .and_then(|a| a.role.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            base_header
                .map(|h| h.title.trim())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("Curriculum Vitae");

    let mut s = String::new();
    s.push_str(&format!(
        "\\documentclass[{},10pt]{{article}}\n",
        paper.latex_option()
    ));
    s.push_str("\\usepackage[empty]{fullpage}\n");
    s.push_str("\\usepackage{titlesec}\n");
    s.push_str("\\usepackage[usenames,dvipsnames]{color}\n");
    s.push_str("\\usepackage{enumitem}\n");
    s.push_str("\\usepackage[hidelinks]{hyperref}\n");
    s.push_str("\\usepackage{fontawesome5}\n");
    s.push_str("\\usepackage[english]{babel}\n");
    s.push_str("\\addtolength{\\oddsidemargin}{-0.6in}\n");
    s.push_str("\\addtolength{\\evensidemargin}{-0.5in}\n");
    s.push_str("\\addtolength{\\textwidth}{1.19in}\n");
    s.push_str("\\addtolength{\\topmargin}{-.7in}\n");
    s.push_str("\\addtolength{\\textheight}{1.4in}\n");
    s.push_str("\\urlstyle{same}\n");
    s.push_str("\\raggedright\n");
    s.push_str("\\titleformat{\\section}{\\vspace{-6pt}\\scshape\\raggedright\\large\\bfseries}{}{0em}{}[\\color{black}\\titlerule \\vspace{-4pt}]\n");
    s.push_str("\\pagenumbering{gobble}\n");
    s.push_str("\\begin{document}\n\n");

    // Header: real name + contacts from the base CV, then the target role.
    // Falls back to just the role when no base header is available.
    match base_header {
        Some(h) if !h.name.trim().is_empty() => {
            s.push_str(&format!(
                "\\begin{{center}}\n    {{\\Huge \\scshape {}}} \\\\ \\vspace{{1pt}}\n    {{\\Large {}}} \\\\ \\vspace{{5pt}}\n",
                tex_escape(h.name.trim()),
                tex_escape(title)
            ));
            let contacts = flat_contact_line(h);
            if !contacts.is_empty() {
                s.push_str(&format!("    \\small\n    {}\n", contacts));
            }
            s.push_str("    \\vspace{-8pt}\n\\end{center}\n\n");
        }
        _ => {
            s.push_str(&format!(
                "\\begin{{center}}\n    {{\\Huge \\scshape {}}}\n\\end{{center}}\n\n",
                tex_escape(title)
            ));
        }
    }

    for section in &sections {
        s.push_str(&format!("\\section{{{}}}\n", tex_escape(&section.section)));
        if !section.bullets.is_empty() {
            s.push_str("\\begin{itemize}[leftmargin=0.15in, itemsep=1pt, topsep=2pt]\n");
            for b in &section.bullets {
                s.push_str(&format!("  \\item \\small{{{}}}\n", tex_escape(b)));
            }
            s.push_str("\\end{itemize}\n\n");
        }
    }

    s.push_str("\\end{document}\n");
    Ok(s)
}

/// Render a `ResumeDoc` through the Tera-templated LaTeX source.
///
/// The template lives at `backend/templates/cv.tex.tera`. Every interpolated
/// value passes through the `tex` filter which escapes LaTeX specials so user
/// input can never break compilation.
pub async fn render_cv(doc: &ResumeDoc, paper: Paper) -> Result<Vec<u8>> {
    let tex_source = expand_template(doc, paper).context("expand Tera template")?;
    render_tex(&tex_source).await
}

/// Build the Tera engine, register filters, render `cv.tex.tera` against the
/// provided `ResumeDoc`. Returns the populated `.tex` source.
fn expand_template(doc: &ResumeDoc, paper: Paper) -> Result<String> {
    let mut tera = tera::Tera::default();
    tera.register_filter("tex", tex_escape_filter);
    tera.register_filter("url", tex_url_filter);
    tera.add_raw_template("cv.tex.tera", TEMPLATE_CV_TERA)
        .context("register cv.tex.tera with Tera")?;

    let mut ctx =
        tera::Context::from_serialize(doc).context("serialize ResumeDoc into Tera context")?;
    ctx.insert("paper", paper.latex_option());

    tera.render("cv.tex.tera", &ctx)
        .context("render cv.tex.tera")
}

/// Escape LaTeX specials in a user-provided string.
///
/// Backslash MUST be handled first — every other replacement introduces new
/// backslashes that we don't want to re-escape.
pub fn tex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' => out.push_str("\\&"),
            '%' => out.push_str("\\%"),
            '$' => out.push_str("\\$"),
            '#' => out.push_str("\\#"),
            '_' => out.push_str("\\_"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            // ASCII control chars (TAB / NL etc.) pass through; LaTeX handles
            // them as whitespace. Non-ASCII unicode characters are passed
            // through verbatim — XeTeX renders them natively.
            other => out.push(other),
        }
    }
    out
}

/// Make a user-supplied URL safe inside `\\href{...}`.
///
/// `tex_escape` is wrong for URLs (it would turn `_` into `\\_` inside the
/// link target), but URLs still must not be able to close the group and run
/// their own commands: `https://x.co/}\\input{/etc/passwd}` would otherwise
/// read a server file into the PDF. Backslashes, braces, whitespace and
/// control characters are percent-encoded, which keeps the link working and
/// leaves nothing for TeX to interpret. `%` is escaped as `\\%`, which hyperref
/// turns back into a literal percent in the link.
pub fn tex_url(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("%5C"),
            '{' => out.push_str("%7B"),
            '}' => out.push_str("%7D"),
            '%' => out.push_str("\\%"),
            c if c.is_whitespace() || c.is_control() => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn tex_url_filter(
    value: &tera::Value,
    _args: &HashMap<String, tera::Value>,
) -> tera::Result<tera::Value> {
    let s = value
        .as_str()
        .ok_or_else(|| tera::Error::msg("url filter expects a string"))?;
    Ok(tera::Value::String(tex_url(s)))
}

/// Tera filter wrapper around `tex_escape`. Used in the template as
/// `{{ field | tex }}`.
fn tex_escape_filter(
    value: &tera::Value,
    _args: &HashMap<String, tera::Value>,
) -> tera::Result<tera::Value> {
    let s = value
        .as_str()
        .ok_or_else(|| tera::Error::msg("tex filter expects a string"))?;
    Ok(tera::Value::String(tex_escape(s)))
}

/// Render a structured cover letter to PDF. Builds a simple, standard
/// article-class letter (no exotic packages → reliable Tectonic compile) and
/// runs it through the same Tectonic path as the CV.
pub async fn render_cover_letter(doc: &super::CoverLetterDoc, paper: Paper) -> Result<Vec<u8>> {
    render_tex(&build_cover_letter_tex(doc, paper)).await
}

/// Assemble the `.tex` source for a cover letter. Each logical block is its own
/// paragraph (blank-line separated); `parskip` gives the spacing. Every
/// interpolated value is `tex_escape`d so user content can't break compilation.
fn build_cover_letter_tex(doc: &super::CoverLetterDoc, paper: Paper) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "\\documentclass[{},11pt]{{article}}\n",
        paper.latex_option()
    ));
    s.push_str("\\usepackage[margin=1in]{geometry}\n");
    s.push_str("\\usepackage{parskip}\n");
    s.push_str("\\usepackage[hidelinks]{hyperref}\n");
    s.push_str("\\pagenumbering{gobble}\n");
    s.push_str("\\begin{document}\n\n");

    s.push_str(&format!(
        "{{\\Large \\textbf{{{}}}}}\n\n",
        tex_escape(&doc.candidate_name)
    ));
    if let Some(c) = doc.candidate_contact.as_deref() {
        if !c.trim().is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(c)));
        }
    }
    if let Some(d) = doc.date.as_deref() {
        if !d.trim().is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(d)));
        }
    }
    if let Some(co) = doc.company.as_deref() {
        if !co.trim().is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(co)));
        }
    }
    if let Some(g) = doc.greeting.as_deref() {
        if !g.trim().is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(g)));
        }
    }
    for p in &doc.paragraphs {
        if !p.trim().is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(p)));
        }
    }
    if let Some(so) = doc.signoff.as_deref() {
        if !so.trim().is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(so)));
        }
    }
    s.push_str(&format!("{}\n\n", tex_escape(&doc.candidate_name)));
    s.push_str("\\end{document}\n");
    s
}

/// Compile arbitrary .tex source through tectonic.
///
/// Approach: write the source to a scratch tempdir, invoke `tectonic --outdir
/// <tempdir> <tempdir>/cv.tex`, then read back `cv.pdf`. Tectonic's stdin/
/// stdout piping is brittle across versions; the tempdir route is portable.
pub async fn render_tex(tex_source: &str) -> Result<Vec<u8>> {
    let tmp = tempfile::Builder::new()
        .prefix("diligently-tex-")
        .tempdir()
        .context("create temp dir for tectonic")?;

    let tex_path = tmp.path().join("cv.tex");
    let pdf_path = tmp.path().join("cv.pdf");

    tokio::fs::write(&tex_path, tex_source)
        .await
        .context("write tex to temp dir")?;

    let bin = tectonic_bin();
    let output = Command::new(&bin)
        .arg("--outdir")
        .arg(tmp.path())
        .arg("--chatter=minimal")
        .arg("--keep-logs")
        .arg(&tex_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("spawn tectonic ({bin}) — is it installed and on PATH?"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Tectonic writes its own .log alongside the .tex; include the tail so
        // LaTeX-level errors (missing package, malformed macro, etc.) surface
        // in the job's `last_error` column.
        let log_tail = tokio::fs::read_to_string(tmp.path().join("cv.log"))
            .await
            .map(|s| {
                s.lines()
                    .rev()
                    .take(40)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        return Err(anyhow!(
            "tectonic compile failed (exit {:?})\nstderr:\n{}\nstdout:\n{}\nlog tail:\n{}",
            output.status.code(),
            stderr,
            stdout,
            log_tail
        ));
    }

    let pdf_bytes = tokio::fs::read(&pdf_path)
        .await
        .context("read tectonic output cv.pdf")?;

    if pdf_bytes.is_empty() {
        return Err(anyhow!("tectonic produced an empty PDF"));
    }

    Ok(pdf_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tex_url_neutralises_group_breakouts() {
        let evil = r"https://x.co/}\input{/etc/hostname}";
        let safe = tex_url(evil);
        assert!(!safe.contains('\\') || safe.contains("\\%"), "{safe}");
        assert!(!safe.contains('{') && !safe.contains('}'), "{safe}");
        assert_eq!(tex_url("https://x.co/a b"), "https://x.co/a%20b");
        assert_eq!(tex_url("https://x.co/?q=100%"), "https://x.co/?q=100\\%");
        assert_eq!(
            tex_url("https://x.co/my_page#top"),
            "https://x.co/my_page#top"
        );
    }

    #[test]
    fn expanded_template_contains_no_injected_commands() {
        let doc: ResumeDoc = serde_json::from_value(serde_json::json!({
            "header": {
                "name": r"Ada \input{/etc/hostname}",
                "title": "Engineer",
                "email": r"ada@x.co}\input{/etc/hostname}",
                "website": { "url": r"https://x.co/}\input{/etc/hostname}", "display": "x.co" }
            },
            "experience": [{ "role": "Eng", "company": "N", "start": "2021", "end": "Now",
                             "bullets": [r"Did \write18{rm -rf /} things"] }],
            "projects": [{ "description": "Tool", "link": { "url": r"https://g.co/}\def\x{1}", "display": "g" } }]
        }))
        .unwrap();
        let tex = expand_template(&doc, Paper::A4).unwrap();
        for needle in [r"\input{/etc", r"\write18", r"\def\x"] {
            assert!(!tex.contains(needle), "found {needle} in rendered TeX");
        }
    }
}
