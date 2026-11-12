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
    /// Tagline shown under the name, e.g. "AI and Machine Learning Engineer".
    #[serde(default)]
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
    /// Free-form date string. The template does not parse these: whatever
    /// the user wrote ("Oct. 2023", "Present", "2023-10") renders as-is.
    /// Empty when unknown; `check_issues` flags it.
    #[serde(default)]
    pub start: String,
    #[serde(default)]
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
    value.get("header")?;
    serde_json::from_value::<ResumeDoc>(value.clone()).ok()
}

/// Size limits for a CV document. Generous for real CVs, small enough that a
/// single document cannot bloat the database or a prompt.
pub mod limits {
    pub const NAME: usize = 120;
    pub const TITLE: usize = 160;
    pub const SUMMARY: usize = 2_000;
    pub const SHORT: usize = 200;
    pub const BULLET: usize = 600;
    pub const ENTRIES: usize = 30;
    pub const BULLETS_PER_ENTRY: usize = 20;
    pub const SKILL_GROUPS: usize = 20;
    pub const SKILLS_PER_GROUP: usize = 60;
    pub const URL: usize = 500;
}

fn check_len(path: String, value: &str, max: usize) -> Result<(), String> {
    if value.chars().count() > max {
        Err(format!("{path} must be at most {max} characters"))
    } else {
        Ok(())
    }
}

fn check_count(path: &str, n: usize, max: usize) -> Result<(), String> {
    if n > max {
        Err(format!("{path} can have at most {max} entries"))
    } else {
        Ok(())
    }
}

fn check_link(path: &str, link: &Option<Link>) -> Result<(), String> {
    if let Some(l) = link {
        check_len(format!("{path}.url"), &l.url, limits::URL)?;
        check_len(format!("{path}.display"), &l.display, limits::SHORT)?;
        if !(l.url.starts_with("https://")
            || l.url.starts_with("http://")
            || l.url.starts_with("mailto:"))
        {
            return Err(format!(
                "{path}.url must start with https://, http:// or mailto:"
            ));
        }
        if l.url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '{' | '}'))
        {
            return Err(format!("{path}.url contains characters a link cannot have"));
        }
    }
    Ok(())
}

/// Hard validation: shape and size. Returns a message naming the offending
/// path, for example `experience[2].bullets[0] must be at most 600 characters`.
pub fn validate(doc: &ResumeDoc) -> Result<(), String> {
    use limits::*;
    if doc.header.name.trim().is_empty() {
        return Err("header.name is required".into());
    }
    check_len("header.name".into(), &doc.header.name, NAME)?;
    check_len("header.title".into(), &doc.header.title, TITLE)?;
    for (k, v) in [
        ("header.email", &doc.header.email),
        ("header.phone", &doc.header.phone),
    ] {
        if let Some(v) = v {
            check_len(k.into(), v, SHORT)?;
        }
    }
    check_link("header.linkedin", &doc.header.linkedin)?;
    check_link("header.github", &doc.header.github)?;
    check_link("header.website", &doc.header.website)?;
    if let Some(s) = &doc.summary {
        check_len("summary".into(), s, SUMMARY)?;
    }
    check_count("experience", doc.experience.len(), ENTRIES)?;
    for (i, e) in doc.experience.iter().enumerate() {
        for (k, v) in [
            ("role", &e.role),
            ("company", &e.company),
            ("start", &e.start),
            ("end", &e.end),
        ] {
            check_len(format!("experience[{i}].{k}"), v, SHORT)?;
        }
        check_count(
            &format!("experience[{i}].bullets"),
            e.bullets.len(),
            BULLETS_PER_ENTRY,
        )?;
        for (j, b) in e.bullets.iter().enumerate() {
            check_len(format!("experience[{i}].bullets[{j}]"), b, BULLET)?;
        }
    }
    check_count("education", doc.education.len(), ENTRIES)?;
    for (i, e) in doc.education.iter().enumerate() {
        check_len(format!("education[{i}].institution"), &e.institution, SHORT)?;
        check_len(format!("education[{i}].degree"), &e.degree, SHORT)?;
    }
    check_count("skills", doc.skills.len(), SKILL_GROUPS)?;
    for (i, g) in doc.skills.iter().enumerate() {
        check_len(format!("skills[{i}].label"), &g.label, SHORT)?;
        check_count(
            &format!("skills[{i}].items"),
            g.items.len(),
            SKILLS_PER_GROUP,
        )?;
        for (j, it) in g.items.iter().enumerate() {
            check_len(format!("skills[{i}].items[{j}]"), it, SHORT)?;
        }
    }
    check_count("projects", doc.projects.len(), ENTRIES)?;
    for (i, p) in doc.projects.iter().enumerate() {
        check_len(format!("projects[{i}].description"), &p.description, BULLET)?;
        check_link(&format!("projects[{i}].link"), &p.link)?;
    }
    Ok(())
}

fn cut(s: &mut String, max: usize) {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
    }
}

fn link_ok(l: &Link) -> bool {
    (l.url.starts_with("https://") || l.url.starts_with("http://") || l.url.starts_with("mailto:"))
        && !l
            .url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '{' | '}'))
        && l.url.chars().count() <= limits::URL
}

/// Bring machine-produced documents (a parsed upload) within the limits that
/// `validate` enforces: cut long text, drop excess entries and unusable
/// links. Hand edits are validated instead, so the user sees the problem.
pub fn clamp(doc: &mut ResumeDoc) {
    use limits::*;
    let h = &mut doc.header;
    cut(&mut h.name, NAME);
    cut(&mut h.title, TITLE);
    for v in [&mut h.email, &mut h.phone].into_iter().flatten() {
        cut(v, SHORT);
    }
    for l in [&mut h.linkedin, &mut h.github, &mut h.website] {
        if let Some(link) = l {
            cut(&mut link.display, SHORT);
            if !link_ok(link) {
                *l = None;
            }
        }
    }
    if let Some(s) = &mut doc.summary {
        cut(s, SUMMARY);
    }
    doc.experience.truncate(ENTRIES);
    for e in &mut doc.experience {
        for v in [&mut e.role, &mut e.company, &mut e.start, &mut e.end] {
            cut(v, SHORT);
        }
        if let Some(l) = &mut e.location {
            cut(l, SHORT);
        }
        e.bullets.retain(|b| !b.trim().is_empty());
        e.bullets.truncate(BULLETS_PER_ENTRY);
        for b in &mut e.bullets {
            cut(b, BULLET);
        }
    }
    doc.education.truncate(ENTRIES);
    for e in &mut doc.education {
        cut(&mut e.institution, SHORT);
        cut(&mut e.degree, SHORT);
        for v in [&mut e.location, &mut e.start, &mut e.end]
            .into_iter()
            .flatten()
        {
            cut(v, SHORT);
        }
    }
    doc.skills.truncate(SKILL_GROUPS);
    for g in &mut doc.skills {
        cut(&mut g.label, SHORT);
        g.items.retain(|i| !i.trim().is_empty());
        g.items.truncate(SKILLS_PER_GROUP);
        for i in &mut g.items {
            cut(i, SHORT);
        }
    }
    doc.projects.truncate(ENTRIES);
    for p in &mut doc.projects {
        if let Some(n) = &mut p.name {
            cut(n, SHORT);
        }
        cut(&mut p.description, BULLET);
        if let Some(l) = &mut p.link {
            cut(&mut l.display, SHORT);
            if !link_ok(l) {
                p.link = None;
            }
        }
    }
}

/// Something worth the user's attention before the CV is used, shown on the
/// Check screen. Not an error: the CV still saves and renders.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

pub fn check_issues(doc: &ResumeDoc) -> Vec<Issue> {
    let mut out = Vec::new();
    let mut push = |path: String, message: String| out.push(Issue { path, message });
    if doc.header.title.trim().is_empty() {
        push(
            "header.title".into(),
            "Add a headline, for example your current title.".into(),
        );
    }
    if doc.header.email.as_deref().unwrap_or("").trim().is_empty() {
        push(
            "header.email".into(),
            "Add an email so employers can reach you.".into(),
        );
    }
    if doc.experience.is_empty() {
        push(
            "experience".into(),
            "No experience found. Add at least one role.".into(),
        );
    }
    for (i, e) in doc.experience.iter().enumerate() {
        let at = if e.company.trim().is_empty() {
            "this role".to_string()
        } else {
            e.company.trim().to_string()
        };
        if e.start.trim().is_empty() || e.end.trim().is_empty() {
            push(
                format!("experience[{i}]"),
                format!("Dates are missing for {at}."),
            );
        }
        if e.bullets.iter().all(|b| b.trim().is_empty()) {
            push(
                format!("experience[{i}].bullets"),
                format!("Add what you did at {at}."),
            );
        }
    }
    if doc.skills.iter().all(|g| g.items.is_empty()) {
        push(
            "skills".into(),
            "No skills found. Add the tools you use.".into(),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> ResumeDoc {
        serde_json::from_value(json!({
            "header": { "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com" },
            "experience": [
                { "role": "Engineer", "company": "Northfold", "start": "2021", "end": "Present", "bullets": ["Built a ledger"] },
                { "role": "Engineer", "company": "Kestrel", "bullets": ["Shipped APIs"] }
            ],
            "skills": [{ "label": "Languages", "items": ["Go", "Rust"] }]
        }))
        .unwrap()
    }

    #[test]
    fn missing_dates_are_an_issue_not_an_error() {
        let d = doc();
        assert!(validate(&d).is_ok());
        let issues = check_issues(&d);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].path, "experience[1]");
        assert!(issues[0].message.contains("Kestrel"));
    }

    #[test]
    fn validation_names_the_offending_path() {
        let mut d = doc();
        d.experience[0].bullets.push("x".repeat(601));
        assert_eq!(
            validate(&d).unwrap_err(),
            "experience[0].bullets[1] must be at most 600 characters"
        );
        let mut d = doc();
        d.header.name = "  ".into();
        assert!(validate(&d).is_err());
        let mut d = doc();
        d.header.website = Some(Link {
            url: "javascript:alert(1)".into(),
            display: "x".into(),
        });
        assert!(validate(&d).unwrap_err().contains("header.website.url"));
    }
}
