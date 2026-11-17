//! Writing preferences reach the AI: one spelling line in every prompt that
//! writes text the user will send, and the default letter tone.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::TestApp;
use fixture::{ready_user, started};
use serde_json::json;

const GB: &str = "Use British English spelling.";
const US: &str = "Use American English spelling.";

/// The system prompt of the newest request for `task`.
fn system_of(app: &TestApp, task: &str) -> String {
    app.ai
        .requests()
        .into_iter()
        .rev()
        .find(|r| r.task == task)
        .unwrap_or_else(|| panic!("no {task} request"))
        .system
}

#[tokio::test]
async fn spelling_is_inferred_from_location_then_follows_the_setting() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    c.patch(
        "/v1/profile",
        json!({ "location": "Austin, United States" }),
    )
    .await;
    let id = started(&app, &c).await;
    for task in ["rewrites", "cover_letter"] {
        let s = system_of(&app, task);
        assert!(s.ends_with(US), "{task}: {s}");
        assert!(!s.contains(GB), "{task}: one line only");
    }
    // Prompts that write nothing the user sends stay as they were.
    for task in ["jd_analysis", "ats_score", "gap_analysis"] {
        let s = system_of(&app, task);
        assert!(!s.contains(US) && !s.contains(GB), "{task}");
    }

    c.patch("/v1/profile", json!({ "writing": { "spelling": "en-GB" } }))
        .await;
    app.ai.answer(
        "follow_up",
        json!({ "subject": "Following up", "body": "Hi {name}, a quick note on my application." }),
    );
    let r = c
        .post(
            &format!("/v1/applications/{id}/follow-ups"),
            json!({ "channel": "email" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(system_of(&app, "follow_up").ends_with(GB));

    let gaps = c.get(&format!("/v1/applications/{id}/gaps")).await.body;
    let gap = gaps["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["requirement"].as_str().unwrap().contains("GraphQL"))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    app.ai.answer(
        "gap_bullet",
        json!({ "bullet": "Designed GraphQL APIs for the merchant dashboard" }),
    );
    let r = c
        .post(
            &format!("/v1/gaps/{gap}/answer"),
            json!({ "have": true, "text": "At Northfold I designed GraphQL APIs for our merchant dashboard", "entry": 0 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(system_of(&app, "gap_bullet").ends_with(GB));
}

#[tokio::test]
async fn the_profile_letter_tone_is_the_default() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    c.patch(
        "/v1/profile",
        json!({ "writing": { "letter_tone": "formal" } }),
    )
    .await;
    let id = started(&app, &c).await;
    let first: String = sqlx::query_scalar("select tone from cover_letters")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(first, "formal", "the pipeline's letter uses the setting");

    c.patch(
        "/v1/profile",
        json!({ "writing": { "letter_tone": "warm" } }),
    )
    .await;
    let r = c
        .post(
            &format!("/v1/applications/{id}/cover-letters/regenerate"),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["tone"], "warm");
    assert!(system_of(&app, "cover_letter").contains("Tone: warm"));

    let r = c
        .post(
            &format!("/v1/applications/{id}/cover-letters/regenerate"),
            json!({ "tone": "direct" }),
        )
        .await;
    assert_eq!(r.body["tone"], "direct", "an explicit tone wins");
}
