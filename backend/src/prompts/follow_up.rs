//! A follow-up message for an application: email or LinkedIn.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{clean, nullable, object, string, VOICE};
use crate::ai::LlmRequest;

pub const TASK: &str = "follow_up";
pub const CHANNELS: &[&str] = &["email", "linkedin"];

fn system(channel: &str) -> String {
    let shape = if channel == "linkedin" {
        "A LinkedIn message: no subject (null), at most 60 words, no greeting line beyond the first name placeholder."
    } else {
        "An email: a short subject line, then a body of at most 120 words."
    };
    format!("You draft a polite follow-up on a job application the candidate already sent.

Rules:
- {shape}
- Reference the role and company. Mention one specific, true detail from the job or the research if there is one.
- Address the reader as {{name}} so the candidate can fill it in; never invent a person's name.
- Sign off with the candidate's name exactly as given.
- No \"just checking in\", \"circling back\", \"touching base\" or \"I'm a perfect fit\". No pressure, no desperation.
- Never invent facts about the candidate or the company.

{VOICE}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Draft {
    pub subject: Option<String>,
    pub body: String,
}

pub fn schema() -> Value {
    object(&[("subject", nullable(string())), ("body", string())])
}

pub fn request(
    channel: &str,
    candidate: &str,
    role: &str,
    company: &str,
    days_since: i64,
    context: &str,
) -> LlmRequest {
    LlmRequest {
        task: TASK,
        system: system(channel),
        user_text: format!(
            "Candidate: {candidate}\nRole: {role}\nCompany: {company}\nApplied {days_since} days ago.\n\n<context>\n{context}\n</context>"
        ),
        pdf_base64: None,
        schema: schema(),
        max_tokens: 1_500,
        effort: "low",
    }
}

pub fn parse(v: Value, channel: &str, candidate: &str) -> Result<Draft, String> {
    let d: Draft = serde_json::from_value(v).map_err(|e| e.to_string())?;
    // A placeholder for the sender is never useful; the model knows the name.
    let body = clean(&d.body)
        .replace("{candidate_name}", candidate)
        .replace("{your_name}", candidate);
    if body.is_empty() || body.chars().count() > 1_500 {
        return Err("draft empty or too long".into());
    }
    let subject = if channel == "linkedin" {
        None
    } else {
        d.subject
            .map(|s| clean(&s).chars().take(150).collect::<String>())
            .filter(|s| !s.is_empty())
    };
    Ok(Draft { subject, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn linkedin_drafts_have_no_subject_and_sign_with_the_name() {
        assert!(super::super::all_objects_closed(&schema()));
        let d = parse(
            json!({ "subject": "Hi", "body": "Hi {name}, thanks.\n{candidate_name}" }),
            "linkedin",
            "Ada Okafor",
        )
        .unwrap();
        assert_eq!(d.subject, None);
        assert!(d.body.ends_with("Ada Okafor"), "{}", d.body);
        assert!(d.body.contains("{name}"), "the reader placeholder stays");
        assert!(parse(json!({ "subject": null, "body": " " }), "email", "Ada").is_err());
    }
}
