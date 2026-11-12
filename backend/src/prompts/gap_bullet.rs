//! "I have this": turn what the user says about a gap into one CV bullet,
//! using only their words.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{clean, invents_no_numbers, object, string, VOICE};
use crate::ai::LlmRequest;

pub const TASK: &str = "gap_bullet";

fn system() -> String {
    format!("You write one CV bullet from a candidate's own description of their experience.

Rules:
- Use only what the candidate wrote. Do not add tools, numbers, scope or outcomes they did not mention.
- One line, about 12 to 20 words, starting with a strong past-tense verb.
- Work in the requirement's wording where it is true to what they wrote.
- If what they wrote does not show the requirement at all, set bullet to an empty string.

{VOICE}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GapBullet {
    pub bullet: String,
}

pub fn schema() -> Value {
    object(&[("bullet", string())])
}

pub fn request(requirement: &str, evidence: &str, role_context: &str) -> LlmRequest {
    LlmRequest {
        task: TASK,
        system: system(),
        user_text: format!(
            "Requirement: {requirement}\nWhere it applies: {role_context}\n\n<candidate_words>\n{evidence}\n</candidate_words>"
        ),
        pdf_base64: None,
        schema: schema(),
        max_tokens: 1_000,
        effort: "low",
    }
}

/// None when the model found nothing usable or added numbers.
pub fn parse(v: Value, evidence: &str) -> Result<Option<String>, String> {
    let b: GapBullet = serde_json::from_value(v).map_err(|e| e.to_string())?;
    let bullet = clean(&b.bullet);
    if bullet.is_empty() || bullet.chars().count() > 300 || !invents_no_numbers(evidence, &bullet) {
        return Ok(None);
    }
    Ok(Some(bullet))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_users_numbers() {
        assert!(super::super::all_objects_closed(&schema()));
        let ev = "At Northfold I built GraphQL APIs for 3 internal teams";
        assert_eq!(
            parse(
                json!({ "bullet": "Built GraphQL APIs used by 3 internal teams" }),
                ev
            )
            .unwrap()
            .as_deref(),
            Some("Built GraphQL APIs used by 3 internal teams")
        );
        assert_eq!(
            parse(json!({ "bullet": "Built GraphQL APIs for 12 teams" }), ev).unwrap(),
            None
        );
        assert_eq!(parse(json!({ "bullet": "" }), ev).unwrap(), None);
    }
}
