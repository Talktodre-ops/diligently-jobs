//! Cover letter tones and edits, and research refresh.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::TestApp;
use fixture::{ready_user, started};
use serde_json::json;

#[tokio::test]
async fn the_pipeline_letter_is_direct_and_can_be_rewritten_in_another_tone() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let first = c
        .get(&format!("/v1/applications/{id}/cover-letters"))
        .await
        .body;
    assert_eq!(first["tone"], "direct");
    assert_eq!(first["doc"]["candidate_name"], "Ada Okafor");
    assert_eq!(first["doc"]["company"], "Halcyon Health");
    assert_eq!(first["doc"]["greeting"], "Dear Hiring Team,");

    let r = c
        .post(
            &format!("/v1/applications/{id}/cover-letters/regenerate"),
            json!({ "tone": "warm" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["tone"], "warm");
    let req = app
        .ai
        .requests()
        .into_iter()
        .rev()
        .find(|r| r.task == "cover_letter")
        .unwrap();
    assert!(req.system.contains("warm and personal"));
    assert!(
        req.user_text.contains("Series B"),
        "research reaches the letter"
    );
    let latest = c
        .get(&format!("/v1/applications/{id}/cover-letters"))
        .await
        .body;
    assert_eq!(latest["id"], r.body["id"]);

    let r = c
        .post(
            &format!("/v1/applications/{id}/cover-letters/regenerate"),
            json!({ "tone": "shouty" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn gap_answers_reach_the_letter() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let gaps = c.get(&format!("/v1/applications/{id}/gaps")).await.body;
    let hipaa = gaps["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["requirement"] == "HIPAA data")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    c.post(
        &format!("/v1/gaps/{hipaa}/answer"),
        json!({ "have": false }),
    )
    .await;
    c.post(
        &format!("/v1/applications/{id}/cover-letters/regenerate"),
        json!({ "tone": "formal" }),
    )
    .await;
    let req = app
        .ai
        .requests()
        .into_iter()
        .rev()
        .find(|r| r.task == "cover_letter")
        .unwrap();
    assert!(
        req.user_text.contains("Does not have: HIPAA data"),
        "{}",
        req.user_text
    );
}

#[tokio::test]
async fn a_letter_that_invents_numbers_is_refused() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    app.ai.answer(
        "cover_letter",
        json!({ "paragraphs": ["Halcyon is growing.", "I grew revenue 37% at Northfold."] }),
    );
    let r = c
        .post(
            &format!("/v1/applications/{id}/cover-letters/regenerate"),
            json!({ "tone": "direct" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body["error"]["code"], "ai_failed");
}

#[tokio::test]
async fn editing_a_letter_saves_paragraphs_and_clears_old_files() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let letter = c
        .get(&format!("/v1/applications/{id}/cover-letters"))
        .await
        .body;
    let lid = letter["id"].as_str().unwrap().to_string();
    sqlx::query("update cover_letters set r2_pdf_key = 'u/x/letters/old.pdf' where id = $1::uuid")
        .bind(&lid)
        .execute(&app.state.db)
        .await
        .unwrap();
    let r = c
        .patch(
            &format!("/v1/cover-letters/{lid}"),
            json!({ "paragraphs": ["My own opening.", "", "My own close."] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["body"], "My own opening.\n\nMy own close.");
    assert_eq!(
        r.body["doc"]["paragraphs"],
        json!(["My own opening.", "My own close."])
    );
    assert_eq!(r.body["r2_pdf_key"], serde_json::Value::Null);
    let r = c
        .patch(
            &format!("/v1/cover-letters/{lid}"),
            json!({ "paragraphs": [] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn research_is_readable_and_refreshable() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let r = c.get(&format!("/v1/applications/{id}/research")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.body["brief"]["overview"],
        "Halcyon Health builds claims software for clinics."
    );
    assert_eq!(r.body["sources"][0]["url"], "https://news.example/halcyon");

    let before = app.ai.calls("research_brief");
    let r = c
        .post(
            &format!("/v1/applications/{id}/research/refresh"),
            json!({}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(app.ai.calls("research_brief"), before + 1);
    assert!(app
        .web
        .queries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .contains("Halcyon Health"));
}
