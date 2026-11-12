//! The Gaps screen: answers, suggested bullets, and their effect on the CV
//! and the letter.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::TestApp;
use fixture::{ready_user, started};
use serde_json::{json, Value};

async fn gap_ids(c: &common::Client<'_>, app_id: &str) -> Vec<(String, String)> {
    let g = c.get(&format!("/v1/applications/{app_id}/gaps")).await.body;
    g["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g: &Value| {
            (
                g["requirement"].as_str().unwrap().to_string(),
                g["id"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn i_have_this_suggests_a_bullet_that_joins_the_cv_only_when_accepted() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let gaps = gap_ids(&c, &id).await;
    assert_eq!(gaps.len(), 3);
    let (_, graphql) = gaps
        .iter()
        .find(|(r, _)| r.contains("GraphQL"))
        .unwrap()
        .clone();

    app.ai.answer(
        "gap_bullet",
        json!({ "bullet": "Designed GraphQL APIs for the merchant dashboard" }),
    );
    let r = c
        .post(&format!("/v1/gaps/{graphql}/answer"), json!({ "have": true, "text": "At Northfold I designed GraphQL APIs for our merchant dashboard", "entry": 0 }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(
        r.body["gap"]["suggested_bullet"],
        "Designed GraphQL APIs for the merchant dashboard"
    );
    assert_eq!(r.body["gap"]["bullet_status"], "pending");
    assert!(app
        .ai
        .requests()
        .last()
        .unwrap()
        .user_text
        .contains("Senior Backend Engineer at Northfold"));

    let cv = c.get(&format!("/v1/applications/{id}/cv")).await.body;
    assert_eq!(
        cv["doc"]["experience"][0]["bullets"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "not added before accepting"
    );

    let r = c
        .patch(
            &format!("/v1/gaps/{graphql}"),
            json!({ "bullet": "accept" }),
        )
        .await;
    assert_eq!(r.body["gap"]["bullet_status"], "accepted");
    let cv = c.get(&format!("/v1/applications/{id}/cv")).await.body;
    assert_eq!(
        cv["doc"]["experience"][0]["bullets"][2],
        "Designed GraphQL APIs for the merchant dashboard"
    );

    c.patch(
        &format!("/v1/gaps/{graphql}"),
        json!({ "bullet": "discard" }),
    )
    .await;
    let cv = c.get(&format!("/v1/applications/{id}/cv")).await.body;
    assert_eq!(
        cv["doc"]["experience"][0]["bullets"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn i_dont_is_recorded() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let (_, hipaa) = gap_ids(&c, &id)
        .await
        .into_iter()
        .find(|(r, _)| r.contains("HIPAA"))
        .unwrap();
    let r = c
        .post(
            &format!("/v1/gaps/{hipaa}/answer"),
            json!({ "have": false }),
        )
        .await;
    assert_eq!(r.body["gap"]["answer"], "dont");
    assert_eq!(r.body["gap"]["suggested_bullet"], Value::Null);
    let b = c.get(&format!("/v1/applications/{id}/brief")).await.body;
    assert_eq!(b["gaps"]["unanswered"], 1);
}

#[tokio::test]
async fn answers_are_validated() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let (_, gap) = gap_ids(&c, &id).await[1].clone();
    for (body, field) in [
        (json!({ "have": true }), "text"),
        (json!({ "have": true, "text": "yes" }), "text"),
        (
            json!({ "have": true, "text": "I did this at a previous company for years", "entry": 9 }),
            "entry",
        ),
    ] {
        let r = c
            .post(&format!("/v1/gaps/{gap}/answer"), body.clone())
            .await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(r.body["error"]["field"], field);
    }
    let r = c
        .patch(&format!("/v1/gaps/{gap}"), json!({ "bullet": "accept" }))
        .await;
    assert_eq!(r.body["error"]["code"], "no_suggestion");
}

#[tokio::test]
async fn another_user_cannot_see_or_answer_gaps() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    let id = started(&app, &a).await;
    let (_, gap) = gap_ids(&a, &id).await[1].clone();
    assert_eq!(
        b.get(&format!("/v1/applications/{id}/gaps")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(&format!("/v1/gaps/{gap}/answer"), json!({ "have": false }))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.patch(&format!("/v1/gaps/{gap}"), json!({ "bullet": "accept" }))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}
