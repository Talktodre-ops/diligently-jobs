//! The funnel report counts each account once per step from existing data.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::{verified_user, TestApp};
use diligently_api::funnel;
use fixture::{ready_user, started};
use serde_json::json;

#[tokio::test]
async fn each_step_counts_the_accounts_that_reached_it() {
    let app = TestApp::spawn().await;

    // Ada goes all the way: tailored, downloaded, sent, followed up, and
    // starts another application a week later.
    let ada = ready_user(&app, "ada@funnel.test").await;
    let id = started(&app, &ada).await;
    let r = ada
        .post(
            "/v1/events",
            json!({ "kind": funnel::FILES_DOWNLOADED, "application_id": id, "payload": { "format": "pdf" } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let applied = ada
        .post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 7 }),
        )
        .await;
    assert_eq!(applied.status, StatusCode::OK, "{}", applied.body);
    let reminder = applied.body["reminder"]["id"].as_str().unwrap().to_string();
    let done = ada
        .post(&format!("/v1/reminders/{reminder}/done"), json!({}))
        .await;
    assert!(done.status.is_success(), "{}", done.body);
    let again = started(&app, &ada).await;
    sqlx::query(
        "update applications set created_at = now() + interval '8 days' where id = $1::uuid",
    )
    .bind(&again)
    .execute(&app.state.db)
    .await
    .unwrap();

    // Bo verified and added a CV, then stopped.
    ready_user(&app, "bo@funnel.test").await;
    // Cy verified and stopped.
    verified_user(&app, "cy@funnel.test").await;
    // Di signed up and never verified.
    let r = app
        .client()
        .post(
            "/v1/auth/signup",
            json!({ "email": "di@funnel.test", "password": "a long enough passphrase" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    // A browser-test account is left out.
    ready_user(&app, "e2e-ready-1@example.com").await;

    let report = funnel::report(&app.state.db, 8).await.unwrap();
    assert_eq!(report.cohorts.len(), 1, "everyone signed up this week");
    assert_eq!(
        report.total(),
        [4, 3, 2, 1, 1, 1, 1, 1, 1],
        "signed up, verified, CV, started, tailored, downloaded, sent, followed up, came back"
    );
    assert!(report.to_first_tailored_min.is_some());

    let text = funnel::render(&report);
    assert!(text.contains("signed up"), "{text}");
    assert!(text.contains("75%"), "3 of 4 verified: {text}");
}

#[tokio::test]
async fn an_empty_window_says_so() {
    let app = TestApp::spawn().await;
    let report = funnel::report(&app.state.db, 4).await.unwrap();
    assert!(report.cohorts.is_empty());
    assert!(funnel::render(&report).contains("No sign-ups in this window."));
}
