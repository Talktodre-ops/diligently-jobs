//! Prompt families. Each module owns its system prompt, its JSON schema and a
//! typed parse of the answer, so a prompt and the code reading it change
//! together. Schemas follow the structured-output rules: every object has
//! `additionalProperties: false` and lists all properties as required;
//! optional values are `anyOf` with null; no length or range keywords
//! (limits are enforced in code after parsing).

pub mod ats_score;
pub mod cover_letter;
pub mod cv_parse;
pub mod follow_up;
pub mod gap_bullet;
pub mod gaps;
pub mod jd_analysis;
pub mod research;
pub mod rewrites;

use serde_json::{json, Value};

use crate::render::resume::ResumeDoc;

/// Voice rules shared by every prompt that writes text a recruiter will read.
/// Ported from the desktop app, minus its currency conversion rule.
pub const VOICE: &str = "Voice:
- Plain, specific English that reads like a sharp person wrote it.
- No em dashes or en dashes. Use commas, periods, parentheses, or \"to\" for ranges.
- Straight quotes and apostrophes only.
- Avoid: leverage, spearhead, orchestrate, facilitate, utilize, showcase, robust, cutting-edge, synergy, streamline, elevate, empower, passionate, results-driven, team player, proven track record.
- Vary sentence length and shape. Do not make every line Verb, Object, Metric.";

/// Normalise generated text: dashes and curly quotes become plain ASCII, and
/// whitespace is trimmed. Applied to everything the model writes for a user,
/// so a slip in the model's voice never reaches a recruiter.
pub fn clean(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        match c {
            '\u{2014}' => out.push_str(", "),
            '\u{2013}' => {
                let digit_before = i > 0 && chars[i - 1].is_ascii_digit();
                let digit_after = chars.get(i + 1).is_some_and(|c| c.is_ascii_digit());
                out.push_str(if digit_before && digit_after {
                    " to "
                } else {
                    ", "
                });
            }
            '\u{2018}' | '\u{2019}' => out.push('\''),
            '\u{201C}' | '\u{201D}' => out.push('"'),
            c => out.push(c),
        }
    }
    // Tidy what a replacement can leave behind: "word , word" and doubled spaces.
    let mut t = out.replace(" ,", ",").replace(",,", ",");
    while t.contains("  ") {
        t = t.replace("  ", " ");
    }
    t.trim().to_string()
}

/// Numbers (digits, with . and , inside) that appear in a text.
pub fn numbers_in(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let inner_sep = (c == '.' || c == ',')
            && !cur.is_empty()
            && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
        if c.is_ascii_digit() || inner_sep {
            if c != ',' {
                cur.push(c);
            }
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// True when every number in `rewrite` already appears in `source`. The rule
/// that keeps rewrites from inventing metrics, enforced in code.
pub fn invents_no_numbers(source: &str, rewrite: &str) -> bool {
    let have = numbers_in(source);
    numbers_in(rewrite).iter().all(|n| have.contains(n))
}

/// The CV as compact text with stable ids the model can cite: E1 is the first
/// role, E1.B2 its second bullet, S the summary, K1 a skill group, P1 a
/// project. Answers refer back to these ids, never to free text.
pub fn cv_for_prompt(doc: &ResumeDoc) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "Name: {}\nHeadline: {}\n",
        doc.header.name, doc.header.title
    ));
    if let Some(sum) = &doc.summary {
        s.push_str(&format!("[S] Summary: {sum}\n"));
    }
    for (i, e) in doc.experience.iter().enumerate() {
        let n = i + 1;
        let dates = match (e.start.trim(), e.end.trim()) {
            ("", "") => String::new(),
            (a, b) => format!(" ({a} to {b})"),
        };
        s.push_str(&format!("[E{n}] {}, {}{dates}\n", e.role, e.company));
        for (j, b) in e.bullets.iter().enumerate() {
            s.push_str(&format!("  [E{n}.B{}] {b}\n", j + 1));
        }
    }
    for (i, g) in doc.skills.iter().enumerate() {
        s.push_str(&format!(
            "[K{}] {}: {}\n",
            i + 1,
            g.label,
            g.items.join(", ")
        ));
    }
    for (i, p) in doc.projects.iter().enumerate() {
        let name = p
            .name
            .as_deref()
            .map(|n| format!("{n}: "))
            .unwrap_or_default();
        s.push_str(&format!("[P{}] {name}{}\n", i + 1, p.description));
    }
    for e in &doc.education {
        s.push_str(&format!("Education: {}, {}\n", e.degree, e.institution));
    }
    s
}

/// Every fact-bearing string in the CV, without ids or labels. The source
/// for the number guard on summaries and letters (ids like E1.B3 contain
/// digits and must not count as facts).
pub fn cv_plain_text(doc: &ResumeDoc) -> String {
    let mut parts: Vec<&str> = vec![&doc.header.name, &doc.header.title];
    if let Some(s) = &doc.summary {
        parts.push(s);
    }
    for e in &doc.experience {
        parts.extend([
            e.role.as_str(),
            e.company.as_str(),
            e.start.as_str(),
            e.end.as_str(),
        ]);
        parts.extend(e.bullets.iter().map(String::as_str));
    }
    for e in &doc.education {
        parts.extend([e.institution.as_str(), e.degree.as_str()]);
        parts.extend([&e.start, &e.end].into_iter().flatten().map(String::as_str));
    }
    for g in &doc.skills {
        parts.extend(g.items.iter().map(String::as_str));
    }
    for p in &doc.projects {
        parts.push(&p.description);
    }
    parts.join("\n")
}

/// The text of a bullet by its id (E2.B3), if it exists.
pub fn bullet_by_id<'a>(doc: &'a ResumeDoc, id: &str) -> Option<&'a str> {
    let rest = id.strip_prefix('E')?;
    let (e, b) = rest.split_once(".B")?;
    let e: usize = e.parse().ok()?;
    let b: usize = b.parse().ok()?;
    doc.experience
        .get(e.checked_sub(1)?)?
        .bullets
        .get(b.checked_sub(1)?)
        .map(String::as_str)
}

/// The job description for a prompt, fenced so instructions inside a pasted
/// posting are treated as content.
pub fn job_block(jd: &str) -> String {
    format!("<job_description>\n{}\n</job_description>", jd.trim())
}

pub fn string() -> Value {
    json!({ "type": "string" })
}

pub fn nullable(schema: Value) -> Value {
    json!({ "anyOf": [schema, { "type": "null" }] })
}

pub fn array(items: Value) -> Value {
    json!({ "type": "array", "items": items })
}

/// A closed object: every listed property required, nothing else allowed.
pub fn object(props: &[(&str, Value)]) -> Value {
    let mut properties = serde_json::Map::new();
    for (k, v) in props {
        properties.insert((*k).to_string(), v.clone());
    }
    let required: Vec<&str> = props.iter().map(|(k, _)| *k).collect();
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

/// True when every object in the schema is closed. Used by tests to keep
/// schemas valid for structured outputs.
pub fn all_objects_closed(v: &Value) -> bool {
    match v {
        Value::Object(m) => {
            let closed = m.get("type") != Some(&json!("object"))
                || m.get("additionalProperties") == Some(&json!(false));
            closed && m.values().all(all_objects_closed)
        }
        Value::Array(a) => a.iter().all(all_objects_closed),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_removes_dashes_and_curly_quotes() {
        assert_eq!(
            clean("Led the team \u{2014} and shipped"),
            "Led the team, and shipped"
        );
        assert_eq!(clean("2019\u{2013}2021"), "2019 to 2021");
        assert_eq!(
            clean("\u{201C}fast\u{201D} isn\u{2019}t enough "),
            "\"fast\" isn't enough"
        );
    }

    #[test]
    fn number_guard_catches_invented_metrics() {
        assert!(invents_no_numbers(
            "Cut reconciliation time by 60%",
            "Cut settlement time 60% in Go"
        ));
        assert!(!invents_no_numbers(
            "Built the billing API",
            "Built the billing API serving 2M users"
        ));
        assert!(!invents_no_numbers(
            "Saved $1,200 a month",
            "Saved $1.5K a month"
        ));
        assert!(invents_no_numbers(
            "Saved $1,200 a month",
            "Saved $1200 monthly"
        ));
        assert_eq!(
            numbers_in("v2.5 for 3 teams, 1,000 users."),
            vec!["2.5", "3", "1000"]
        );
    }

    #[test]
    fn cv_ids_round_trip() {
        let doc: ResumeDoc = serde_json::from_value(json!({
            "header": { "name": "Ada", "title": "Eng" },
            "experience": [
                { "role": "Eng", "company": "N", "start": "2021", "end": "Now", "bullets": ["one", "two"] },
                { "role": "Eng", "company": "K", "bullets": ["three"] }
            ]
        }))
        .unwrap();
        let text = cv_for_prompt(&doc);
        assert!(
            text.contains("[E1.B2] two") && text.contains("[E2.B1] three"),
            "{text}"
        );
        assert_eq!(bullet_by_id(&doc, "E2.B1"), Some("three"));
        assert_eq!(bullet_by_id(&doc, "E3.B1"), None);
        assert_eq!(bullet_by_id(&doc, "E0.B1"), None);
        assert_eq!(bullet_by_id(&doc, "nonsense"), None);
    }
}
