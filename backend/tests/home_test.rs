//! The Home feed: needs-you cards and this week's timeline.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use common::TestApp;
use diligently_api::{ai::LlmError, followups};
use fixture::{answer_everything, ready_user, started, JD};
use serde_json::{json, Value};

fn types(home: &Value) -> Vec<String> {
    home["needs_you"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["type"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_new_user_has_an_empty_home() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let h = c.get("/v1/home").await.body;
    assert_eq!(h["needs_you"], json!([]));
    assert_eq!(h["this_week"], json!([]));
    assert_eq!(h["stats"]["active"], 0);
    assert_eq!(h["first_name"], "Ada");
}

#[tokio::test]
async fn home_follows_an_application_through_its_life() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;

    let h = c.get("/v1/home").await.body;
    assert_eq!(types(&h), vec!["review"]);
    assert_eq!(
        h["needs_you"][0]["text"],
        "Review 3 rewrites for Halcyon Health"
    );
    assert_eq!(
        h["this_week"][0]["text"],
        "Tailored your CV for Halcyon Health"
    );

    c.post(
        &format!("/v1/applications/{id}/applied"),
        json!({ "reminder_days": 5 }),
    )
    .await;
    let h = c.get("/v1/home").await.body;
    assert!(
        types(&h).is_empty(),
        "applied jobs leave the review list: {h}"
    );
    assert_eq!(h["stats"]["applied_this_week"], 1);
    assert_eq!(h["this_week"][0]["text"], "Applied to Halcyon Health");

    sqlx::query("update reminders set due_at = now() - interval '1 minute'")
        .execute(&app.state.db)
        .await
        .unwrap();
    app.ai.answer(
        "follow_up",
        json!({ "subject": "Hello", "body": "Hi {name}, following up." }),
    );
    followups::sweep(&app.state).await.unwrap();
    let h = c.get("/v1/home").await.body;
    assert_eq!(types(&h), vec!["follow_up"]);
    assert_eq!(h["needs_you"][0]["text"], "Follow up with Halcyon Health");
    let rid = h["needs_you"][0]["reminder_id"]
        .as_str()
        .unwrap()
        .to_string();

    c.post(&format!("/v1/reminders/{rid}/done"), json!({}))
        .await;
    c.patch(
        &format!("/v1/applications/{id}/stage"),
        json!({ "stage": "interviewing" }),
    )
    .await;
    let h = c.get("/v1/home").await.body;
    assert_eq!(types(&h), vec!["prepare"]);
    let lines: Vec<&str> = h["this_week"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(lines[0], "Interviewing at Halcyon Health");
    assert!(lines.contains(&"Followed up with Halcyon Health"));
    assert_eq!(h["stats"]["interviewing"], 1);
}

#[tokio::test]
async fn a_failed_pipeline_asks_to_be_finished() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    app.ai
        .fail("jd_analysis", LlmError::Upstream("down".into()));
    c.post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    for _ in 0..2 {
        app.drain_jobs().await;
        sqlx::query("update jobs set scheduled_at = now()")
            .execute(&app.state.db)
            .await
            .unwrap();
    }
    let h = c.get("/v1/home").await.body;
    assert_eq!(types(&h), vec!["retry"]);
    assert_eq!(h["needs_you"][0]["text"], "Finish tailoring for this job");
}

#[tokio::test]
async fn home_shows_only_the_users_own_work() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    started(&app, &a).await;
    let h = b.get("/v1/home").await.body;
    assert_eq!(h["needs_you"], json!([]));
    assert_eq!(h["this_week"], json!([]));
}
