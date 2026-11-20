//! Build the tailored CV for an application: the master CV the pipeline
//! started from, plus the user's decisions. Nothing reaches the tailored CV
//! without a decision: pending rewrites and unanswered gaps leave the master
//! text in place.

use crate::render::resume::{ExperienceEntry, ResumeDoc};

#[derive(Debug, Clone)]
pub struct BulletChange {
    pub bullet_id: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct AddedBullet {
    /// Index into experience (0 is the first role).
    pub entry: usize,
    pub text: String,
}

/// Replace bullets by id, swap in the summary, append accepted gap bullets.
/// Unknown ids and out-of-range entries are ignored rather than guessed.
pub fn compose(
    master: &ResumeDoc,
    changes: &[BulletChange],
    summary: Option<&str>,
    added: &[AddedBullet],
) -> ResumeDoc {
    let mut doc = master.clone();
    for c in changes {
        if let Some((e, b)) = parse_id(&c.bullet_id) {
            if let Some(slot) = doc.experience.get_mut(e).and_then(|x| x.bullets.get_mut(b)) {
                *slot = c.text.clone();
            }
        }
    }
    if let Some(s) = summary {
        doc.summary = Some(s.to_string());
    }
    for a in added {
        if let Some(ExperienceEntry { bullets, .. }) = doc.experience.get_mut(a.entry) {
            bullets.push(a.text.clone());
        }
    }
    doc
}

/// "E2.B3" to zero-based (1, 2).
pub fn parse_id(id: &str) -> Option<(usize, usize)> {
    let (e, b) = id.strip_prefix('E')?.split_once(".B")?;
    Some((
        e.parse::<usize>().ok()?.checked_sub(1)?,
        b.parse::<usize>().ok()?.checked_sub(1)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decisions_apply_and_nothing_else_changes() {
        let master: ResumeDoc = serde_json::from_value(json!({
            "header": { "name": "Ada", "title": "Eng" },
            "summary": "Old summary",
            "experience": [{ "role": "Eng", "company": "N", "bullets": ["one", "two"] }]
        }))
        .unwrap();
        let out = compose(
            &master,
            &[
                BulletChange {
                    bullet_id: "E1.B2".into(),
                    text: "TWO".into(),
                },
                BulletChange {
                    bullet_id: "E9.B1".into(),
                    text: "ignored".into(),
                },
            ],
            Some("New summary"),
            &[
                AddedBullet {
                    entry: 0,
                    text: "three".into(),
                },
                AddedBullet {
                    entry: 5,
                    text: "ignored".into(),
                },
            ],
        );
        assert_eq!(out.experience[0].bullets, vec!["one", "TWO", "three"]);
        assert_eq!(out.summary.as_deref(), Some("New summary"));
        assert_eq!(
            master.experience[0].bullets,
            vec!["one", "two"],
            "master untouched"
        );
    }
}
