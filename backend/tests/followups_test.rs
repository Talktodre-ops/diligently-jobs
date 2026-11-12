//! Follow-up drafts, the reminder sweep (exactly once) and snooze/done.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::{Client, TestApp};
use diligently_api::ai::LlmError;
use diligently_api::followups;
use fixture::{ready_user, started};
use serde_json::json;

fn answer_follow_up(app: &TestApp) {
    app.ai.answer(
        "follow_up",
        json!({ "subject": "Senior Backend Engineer application", "body": "Hi {name}, I applied last week and would value a chat.\n{candidate_name}" }),
    );
}

async fn applied_and_due<'a>(app: &'a TestApp, c: &Client<'a>) -> String {
    let id = started(app, c).await;
    c.post(
        &format!("/v1/applications/{id}/applied"),
        json!({ "reminder_days": 5 }),
    )
    .await;
    sqlx::query("update reminders set due_at = now() - interval '1 minute'")
        .execute(&app.state.db)
        .await
        .unwrap();
    id
}

async fn reminder_status(app: &TestApp) -> (String, i32) {
    sqlx::query_as("select status, attempts from reminders order by created_at desc limit 1")
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_due_reminder_drafts_and_emails_exactly_once() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = applied_and_due(&app, &c).await;
    answer_follow_up(&app);
    let mails_before = app.mail.sent().len();

    assert_eq!(followups::sweep(&app.state).await.unwrap(), 1);
    assert_eq!(
        followups::sweep(&app.state).await.unwrap(),
        0,
        "already sent"
    );
    assert_eq!(reminder_status(&app).await.0, "sent");

    let mails: Vec<_> = app.mail.sent().into_iter().skip(mails_before).collect();
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].subject, "Follow up with Halcyon Health");
    assert!(mails[0].text.contains("I applied last week"));
    assert!(mails[0].text.contains(&format!("/jobs/{id}/follow-up")));
    assert!(mails[0].idempotency_key.starts_with("reminder-"));

    let f = c
        .get(&format!("/v1/applications/{id}/follow-ups"))
        .await
        .body;
    let body = f["drafts"]["email"]["body"].as_str().unwrap();
    assert!(
        body.ends_with("Ada Okafor"),
        "signed with the real name: {body}"
    );
    assert_eq!(f["drafts"]["linkedin"], serde_json::Value::Null);
    assert_eq!(f["reminder"]["status"], "sent");
}

#[tokio::test]
async fn concurrent_sweeps_still_send_once() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    applied_and_due(&app, &c).await;
    answer_follow_up(&app);
    let before = app.mail.sent().len();
    let (a, b, d) = tokio::join!(
        followups::sweep(&app.state),
        followups::sweep(&app.state),
        followups::sweep(&app.state)
    );
    assert_eq!(a.unwrap() + b.unwrap() + d.unwrap(), 1);
    assert_eq!(app.mail.sent().len() - before, 1);
}

#[tokio::test]
async fn reminders_respect_the_notification_switch() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    c.patch(
        "/v1/profile",
        json!({ "notifications": { "follow_ups": false } }),
    )
    .await;
    applied_and_due(&app, &c).await;
    answer_follow_up(&app);
    let before = app.mail.sent().len();
    assert_eq!(followups::sweep(&app.state).await.unwrap(), 1);
    assert_eq!(app.mail.sent().len(), before, "no email");
    assert_eq!(
        app.ai.calls("follow_up"),
        1,
        "the draft is still ready in the app"
    );
}

#[tokio::test]
async fn failures_retry_later_then_give_up() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    applied_and_due(&app, &c).await;
    app.ai.fail("follow_up", LlmError::Upstream("down".into()));
    for attempt in 1..=3 {
        assert_eq!(followups::sweep(&app.state).await.unwrap(), 0);
        let (status, attempts) = reminder_status(&app).await;
        assert_eq!(attempts, attempt);
        assert_eq!(status, if attempt < 3 { "scheduled" } else { "failed" });
        let later: bool =
            sqlx::query_scalar("select due_at > now() + interval '50 minutes' from reminders")
                .fetch_one(&app.state.db)
                .await
                .unwrap();
        assert!(later, "pushed an hour out");
        sqlx::query("update reminders set due_at = now() - interval '1 minute'")
            .execute(&app.state.db)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_send_interrupted_by_a_crash_is_picked_up_again() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    applied_and_due(&app, &c).await;
    answer_follow_up(&app);
    sqlx::query("update reminders set status = 'sending'")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(
        followups::sweep(&app.state).await.unwrap(),
        0,
        "fresh 'sending' rows are left alone"
    );
    sqlx::query("alter table reminders disable trigger reminders_set_updated_at")
        .execute(&app.state.db)
        .await
        .unwrap();
    sqlx::query("update reminders set updated_at = now() - interval '11 minutes'")
        .execute(&app.state.db)
        .await
        .unwrap();
    sqlx::query("alter table reminders enable trigger reminders_set_updated_at")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(followups::sweep(&app.state).await.unwrap(), 1);
}

#[tokio::test]
async fn drafts_snooze_and_done() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;
    let r = c
        .post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 7 }),
        )
        .await;
    let rid = r.body["reminder"]["id"].as_str().unwrap().to_string();

    app.ai.answer("follow_up", json!({ "subject": "ignored on LinkedIn", "body": "Hi {name}, quick note on my application." }));
    let d = c
        .post(
            &format!("/v1/applications/{id}/follow-ups"),
            json!({ "channel": "linkedin" }),
        )
        .await;
    assert_eq!(d.status, StatusCode::OK, "{}", d.body);
    assert_eq!(d.body["draft"]["subject"], serde_json::Value::Null);
    assert!(app
        .ai
        .requests()
        .last()
        .unwrap()
        .user_text
        .contains("Candidate: Ada Okafor"));
    let bad = c
        .post(
            &format!("/v1/applications/{id}/follow-ups"),
            json!({ "channel": "fax" }),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);

    let s = c
        .post(&format!("/v1/reminders/{rid}/snooze"), json!({ "days": 3 }))
        .await;
    assert_eq!(s.body["reminder"]["status"], "scheduled");
    let soon: bool = sqlx::query_scalar("select due_at between now() + interval '71 hours' and now() + interval '73 hours' from reminders")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(soon);
    assert_eq!(
        c.post(
            &format!("/v1/reminders/{rid}/snooze"),
            json!({ "days": 30 })
        )
        .await
        .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let done = c
        .post(&format!("/v1/reminders/{rid}/done"), json!({}))
        .await;
    assert_eq!(done.body["reminder"]["status"], "done");
    assert_eq!(followups::sweep(&app.state).await.unwrap(), 0);
}

#[tokio::test]
async fn another_user_cannot_touch_follow_ups_or_reminders() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    let id = started(&app, &a).await;
    let r = a
        .post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 7 }),
        )
        .await;
    let rid = r.body["reminder"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        b.get(&format!("/v1/applications/{id}/follow-ups"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(
            &format!("/v1/applications/{id}/follow-ups"),
            json!({ "channel": "email" })
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(&format!("/v1/reminders/{rid}/snooze"), json!({ "days": 2 }))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.post(&format!("/v1/reminders/{rid}/done"), json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(reminder_status(&app).await.0, "scheduled");
}
