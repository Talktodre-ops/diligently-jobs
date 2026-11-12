//! Stages, marking an application sent with a reminder, and pipeline retry.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::TestApp;
use diligently_api::ai::LlmError;
use fixture::{answer_everything, ready_user, started, JD};
use serde_json::json;

#[tokio::test]
async fn mark_applied_sets_the_stage_and_schedules_one_reminder() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;

    let r = c
        .post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 7 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["stage"], "applied");
    let due = r.body["reminder"]["due_at"].as_str().unwrap();
    let due = chrono::DateTime::parse_from_rfc3339(due).unwrap();
    let days = (due.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours();
    assert!((167..=168).contains(&days), "{days} hours");

    // Marking again replaces the reminder instead of adding a second.
    c.post(
        &format!("/v1/applications/{id}/applied"),
        json!({ "reminder_days": 5 }),
    )
    .await;
    let scheduled: i64 =
        sqlx::query_scalar("select count(*) from reminders where status = 'scheduled'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(scheduled, 1);

    let applied = c.get("/v1/applications?stage=applied").await.body;
    assert_eq!(applied[0]["id"], id);
    assert!(applied[0]["submitted_at"].is_string());
    assert_eq!(c.get("/v1/applications?stage=saved").await.body, json!([]));
    let counts = c.get("/v1/applications/stages").await.body;
    assert_eq!(counts["stages"]["applied"], 1);
    assert_eq!(counts["stages"]["offer"], 0);

    let r = c
        .post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 90 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn stage_changes_are_recorded_and_closing_cancels_reminders() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    c.post(
        &format!("/v1/applications/{id}/applied"),
        json!({ "reminder_days": 7 }),
    )
    .await;
    let r = c
        .patch(
            &format!("/v1/applications/{id}/stage"),
            json!({ "stage": "interviewing" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    c.patch(
        &format!("/v1/applications/{id}/stage"),
        json!({ "stage": "closed" }),
    )
    .await;
    let status: String = sqlx::query_scalar("select status from reminders")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(status, "cancelled");
    let changes: i64 =
        sqlx::query_scalar("select count(*) from events where kind = 'stage_changed'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(changes, 2);
    let r = c
        .patch(
            &format!("/v1/applications/{id}/stage"),
            json!({ "stage": "ghosted" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        c.get("/v1/applications?stage=nope").await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn a_failed_pipeline_can_be_retried_once_it_has_failed() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    answer_everything(&app);
    app.ai.fail("rewrites", LlmError::Upstream("down".into()));
    let res = c
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    let id = res.body["application_id"].as_str().unwrap().to_string();
    for _ in 0..2 {
        app.drain_jobs().await;
        sqlx::query("update jobs set scheduled_at = now()")
            .execute(&app.state.db)
            .await
            .unwrap();
    }
    answer_everything(&app);
    let r = c
        .post(&format!("/v1/applications/{id}/pipeline/retry"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    app.drain_jobs().await;
    let b = c.get(&format!("/v1/applications/{id}/brief")).await.body;
    assert_eq!(b["pipeline"]["status"], "done");
    assert_eq!(
        app.ai.calls("jd_analysis"),
        1,
        "finished steps are not repeated"
    );
    let r = c
        .post(&format!("/v1/applications/{id}/pipeline/retry"), json!({}))
        .await;
    assert_eq!(r.body["error"]["code"], "pipeline_not_failed");
}

#[tokio::test]
async fn another_user_cannot_move_or_mark_an_application() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    let id = started(&app, &a).await;
    assert_eq!(
        b.patch(
            &format!("/v1/applications/{id}/stage"),
            json!({ "stage": "closed" })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 5 })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(&format!("/v1/applications/{id}/pipeline/retry"), json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.get("/v1/applications/stages").await.body["stages"]["saved"],
        0
    );
}
