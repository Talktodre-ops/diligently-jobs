//! Follow-up drafts, the reminder sweep (exactly once) and snooze/done.

use crate::common;
use crate::fixture;

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
    assert_eq!(mails[0].subject, "Time to follow up with Halcyon Health");
    assert!(mails[0].text.contains("I applied last week"));
    assert!(mails[0]
        .text
        .contains(&format!("/applications/{id}/follow-up")));
    assert!(mails[0].idempotency_key.starts_with("reminder-"));
    // Optional mail: one-click unsubscribe header and footer link.
    let token: String = sqlx::query_scalar("select unsubscribe_token from users")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(mails[0].headers.contains(&(
        "List-Unsubscribe".to_string(),
        format!("<http://app.test/v1/email/unsubscribe/one-click?token={token}&kind=follow_ups>")
    )));
    assert!(mails[0].headers.contains(&(
        "List-Unsubscribe-Post".to_string(),
        "List-Unsubscribe=One-Click".to_string()
    )));
    assert!(mails[0].text.contains(&format!(
        "Turn off follow-up reminders: http://app.test/unsubscribe?token={token}&kind=follow_ups"
    )));
    assert!(mails[0]
        .text
        .contains("They arrive at 9:00 your time, never at weekends."));

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
    // Three days on (five at most, past a weekend), at 09:00 UTC.
    let soon: bool = sqlx::query_scalar(
        "select due_at between now() + interval '2 days' and now() + interval '6 days' \
         and extract(hour from due_at at time zone 'UTC') = 9 and extract(minute from due_at) = 0 from reminders",
    )
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

fn utc(s: &str) -> chrono::DateTime<chrono::Utc> {
    s.parse().unwrap()
}

#[tokio::test]
async fn reminders_fall_at_the_send_hour_in_the_users_zone() {
    let app = TestApp::spawn().await;
    let c = common::verified_user(&app, "ada@example.com").await;
    let uid: uuid::Uuid = c.get("/v1/auth/me").await.body["user"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let due = |days: i64, now: &str| {
        let now = utc(now);
        let db = app.state.db.clone();
        async move {
            followups::reminder_due_at(&db, uid, days, now)
                .await
                .unwrap()
                .to_rfc3339()
        }
    };

    // No zone yet: UTC, 09:00. Wed 18 Nov + 3 days is Saturday, so Monday.
    assert_eq!(
        due(3, "2026-11-18T10:00:00Z").await,
        "2026-11-23T09:00:00+00:00"
    );

    // Lagos is UTC+1: 09:00 there is 08:00 UTC, weekend skipped.
    c.patch(
        "/v1/profile",
        json!({ "reminders": { "time_zone": "Africa/Lagos" } }),
    )
    .await;
    assert_eq!(
        due(3, "2026-11-18T10:00:00Z").await,
        "2026-11-23T08:00:00+00:00"
    );
    // The local date decides "today": 23:30 UTC on Wednesday is already
    // Thursday in Lagos, so +3 lands on Sunday, then Monday.
    assert_eq!(
        due(3, "2026-11-18T23:30:00Z").await,
        "2026-11-23T08:00:00+00:00"
    );
    assert_eq!(
        due(1, "2026-11-18T10:00:00Z").await,
        "2026-11-19T08:00:00+00:00"
    );

    // Weekends allowed and a later send hour.
    c.patch(
        "/v1/profile",
        json!({ "reminders": { "skip_weekends": false, "send_hour": 18 } }),
    )
    .await;
    assert_eq!(
        due(3, "2026-11-18T10:00:00Z").await,
        "2026-11-21T17:00:00+00:00"
    );

    // New York across the end of daylight saving (1 November 2026): Friday
    // 30 October + 5 days is Wednesday 4 November, 09:00 EST = 14:00 UTC.
    c.patch(
        "/v1/profile",
        json!({ "reminders": { "time_zone": "America/New_York", "send_hour": 9, "skip_weekends": true } }),
    )
    .await;
    assert_eq!(
        due(5, "2026-10-30T15:00:00Z").await,
        "2026-11-04T14:00:00+00:00"
    );
}

#[tokio::test]
async fn marking_applied_schedules_in_local_time() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    c.patch(
        "/v1/profile",
        json!({ "reminders": { "time_zone": "Asia/Kolkata", "send_hour": 13 } }),
    )
    .await;
    let id = started(&app, &c).await;
    let r = c
        .post(
            &format!("/v1/applications/{id}/applied"),
            json!({ "reminder_days": 7 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // 13:00 in Kolkata is 07:30 UTC, on a weekday.
    let (hour, minute, dow): (f64, f64, f64) = sqlx::query_as(
        "select extract(hour from due_at at time zone 'Asia/Kolkata')::float8, extract(minute from due_at at time zone 'UTC')::float8, extract(isodow from due_at at time zone 'Asia/Kolkata')::float8 from reminders",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!((hour, minute), (13.0, 30.0));
    assert!(dow <= 5.0, "never at weekends");
}
