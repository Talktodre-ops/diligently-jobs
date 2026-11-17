//! The Monday summary, the running-low email and the new sign-in alert.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::{Method, StatusCode};
use chrono::{DateTime, Utc};
use common::{verified_user, TestApp, APP_ORIGIN};
use diligently_api::digest;
use diligently_api::mail::Email;
use fixture::{ready_user, started};
use serde_json::json;
use uuid::Uuid;

fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

async fn uid(app: &TestApp, email: &str) -> Uuid {
    sqlx::query_scalar("select id from users where email = $1")
        .bind(email)
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

fn subjects_to(app: &TestApp, to: &str, starts: &str) -> Vec<Email> {
    app.mail
        .sent()
        .into_iter()
        .filter(|e| e.to == to && e.subject.starts_with(starts))
        .collect()
}

/// An application applied to on `submitted_at` and heard nothing since.
async fn quiet_application(app: &TestApp, user: Uuid, company: &str, submitted_at: &str) {
    sqlx::query(
        "insert into applications (user_id, jd_raw, company, role, stage, submitted_at) values ($1, 'JD', $2, 'Data Engineer', 'applied', $3)",
    )
    .bind(user)
    .bind(company)
    .bind(at(submitted_at))
    .execute(&app.state.db)
    .await
    .unwrap();
}

// 23 and 30 November 2026 are Mondays.
const MON_EARLY: &str = "2026-11-23T07:30:00Z"; // 08:30 in Lagos
const MON_NINE: &str = "2026-11-23T08:30:00Z"; // 09:30 in Lagos
const MON_LATER: &str = "2026-11-23T15:00:00Z";
const TUE: &str = "2026-11-24T08:30:00Z";
const NEXT_MON: &str = "2026-11-30T08:30:00Z";

#[tokio::test]
async fn the_monday_summary_goes_once_per_local_monday_after_the_send_hour() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    c.patch(
        "/v1/profile",
        json!({ "reminders": { "time_zone": "Africa/Lagos" } }),
    )
    .await;
    started(&app, &c).await; // Tailored, not sent: one thing to do.
    let summaries = || subjects_to(&app, "ada@example.com", "Your week");

    assert_eq!(
        digest::weekly_sweep_at(&app.state, at(MON_EARLY))
            .await
            .unwrap(),
        0,
        "before 09:00 local"
    );
    assert_eq!(
        digest::weekly_sweep_at(&app.state, at(MON_NINE))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        digest::weekly_sweep_at(&app.state, at(MON_LATER))
            .await
            .unwrap(),
        0,
        "once per Monday"
    );
    assert_eq!(
        digest::weekly_sweep_at(&app.state, at(TUE)).await.unwrap(),
        0,
        "Mondays only"
    );
    assert_eq!(summaries().len(), 1);

    let e = &summaries()[0];
    assert_eq!(e.subject, "Your week: 1 draft waiting");
    assert!(e.text.contains("Week of 23 November"), "{}", e.text);
    assert!(e.text.contains("One thing needs you this week"));
    assert!(e.text.contains("Send your Halcyon Health application"));
    assert!(e.text.contains("Sent on Mondays at 9:00 your time"));
    assert!(e.idempotency_key.starts_with("weekly-"));
    assert!(e
        .headers
        .iter()
        .any(|(k, v)| k == "List-Unsubscribe" && v.contains("kind=weekly_summary")));

    assert_eq!(
        digest::weekly_sweep_at(&app.state, at(NEXT_MON))
            .await
            .unwrap(),
        1,
        "the next week"
    );
}

#[tokio::test]
async fn reminders_and_quiet_applications_fill_the_summary() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    c.get("/v1/profile").await;
    let id = uid(&app, "ada@example.com").await;
    quiet_application(&app, id, "Brightwater", "2026-11-02T08:00:00Z").await;
    // Applied to Larkspur on 19 November with a follow-up due on Tuesday.
    quiet_application(&app, id, "Larkspur Payments", "2026-11-19T10:00:00Z").await;
    sqlx::query(
        "insert into reminders (user_id, application_id, due_at) select $1, id, $2 from applications where company = 'Larkspur Payments'",
    )
    .bind(id)
    .bind(at("2026-11-24T09:00:00Z"))
    .execute(&app.state.db)
    .await
    .unwrap();
    // Sent one in the week before.
    sqlx::query("update applications set submitted_at = $1 where company = 'Larkspur Payments'")
        .bind(at("2026-11-19T10:00:00Z"))
        .execute(&app.state.db)
        .await
        .unwrap();

    assert_eq!(
        digest::weekly_sweep_at(&app.state, at("2026-11-23T09:30:00Z"))
            .await
            .unwrap(),
        1
    );
    let e = &subjects_to(&app, "ada@example.com", "Your week")[0];
    assert_eq!(e.subject, "Your week: 1 follow-up due, 1 quiet application");
    assert!(
        e.text.contains("Tue: Follow up with Larkspur Payments"),
        "{}",
        e.text
    );
    assert!(
        e.text.contains("Quiet: Brightwater, 21 days, no reply"),
        "{}",
        e.text
    );
    assert!(e.text.contains("1 sent last week"), "{}", e.text);
    assert!(e.text.contains("1 follow-up due\n"), "{}", e.text);
    assert!(
        e.html.contains("Larkspur Payments is due on Tuesday."),
        "preheader"
    );
}

#[tokio::test]
async fn empty_weeks_and_unverified_or_unsubscribed_users_get_nothing() {
    let app = TestApp::spawn().await;
    // Verified but nothing to do.
    let c = verified_user(&app, "empty@example.com").await;
    c.get("/v1/profile").await;
    // Unverified, with something to do.
    let u = app.client();
    u.post(
        "/v1/auth/signup",
        json!({ "email": "new@example.com", "password": "a long enough passphrase" }),
    )
    .await;
    u.get("/v1/profile").await;
    quiet_application(
        &app,
        uid(&app, "new@example.com").await,
        "Northwind",
        "2026-11-01T10:00:00Z",
    )
    .await;
    // Verified with something to do, but turned the summary off.
    let off = verified_user(&app, "off@example.com").await;
    off.patch(
        "/v1/profile",
        json!({ "notifications": { "weekly_summary": false } }),
    )
    .await;
    quiet_application(
        &app,
        uid(&app, "off@example.com").await,
        "Northwind",
        "2026-11-01T10:00:00Z",
    )
    .await;

    assert_eq!(
        digest::weekly_sweep_at(&app.state, at("2026-11-23T10:00:00Z"))
            .await
            .unwrap(),
        0
    );
    assert!(app
        .mail
        .sent()
        .iter()
        .all(|e| !e.subject.starts_with("Your week")));
    let claimed: Option<chrono::NaiveDate> = sqlx::query_scalar(
        "select weekly_summary_sent_on from profiles p join users u on u.id = p.user_id where u.email = 'empty@example.com'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(
        claimed.unwrap().to_string(),
        "2026-11-23",
        "an empty week is not looked at again"
    );
}

#[tokio::test]
async fn running_low_is_sent_once_a_month_at_two_left() {
    let app = TestApp::spawn_with(|c| {
        c.limits.plan_limits = std::collections::HashMap::from([("free".to_string(), 4)]);
    })
    .await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = uid(&app, "ada@example.com").await;
    let low = || subjects_to(&app, "ada@example.com", "");
    let count = || {
        low()
            .into_iter()
            .filter(|e| e.subject.ends_with("left this month"))
            .count()
    };

    started(&app, &c).await; // 1 of 4 used
    assert_eq!(count(), 0);
    started(&app, &c).await; // 2 of 4: two left
    assert_eq!(count(), 1);
    let e = low()
        .into_iter()
        .find(|e| e.subject.ends_with("left this month"))
        .unwrap();
    assert_eq!(e.subject, "2 applications left this month");
    assert!(e.text.contains("2 of 4 used. Resets on 1 "), "{}", e.text);
    assert!(e
        .text
        .contains("Stop these emails: http://app.test/unsubscribe?token="));
    started(&app, &c).await; // 3 of 4: still only one email this month
    assert_eq!(count(), 1);

    // A new month sends again.
    sqlx::query("update profiles set running_low_sent_for = date '2000-01-01' where user_id = $1")
        .bind(id)
        .execute(&app.state.db)
        .await
        .unwrap();
    digest::after_application_started(&app.state, id, "free").await;
    assert_eq!(count(), 2);
}

#[tokio::test]
async fn running_low_skips_small_plans_and_the_switch() {
    let app = TestApp::spawn_with(|c| {
        c.limits.plan_limits =
            std::collections::HashMap::from([("free".to_string(), 2), ("pro".to_string(), 3)]);
    })
    .await;
    let c = verified_user(&app, "ada@example.com").await;
    c.get("/v1/profile").await;
    let id = uid(&app, "ada@example.com").await;
    quiet_application(&app, id, "Northwind", "2026-11-01T10:00:00Z").await;
    sqlx::query("update applications set created_at = now()")
        .execute(&app.state.db)
        .await
        .unwrap();
    digest::after_application_started(&app.state, id, "free").await;
    assert!(
        subjects_to(&app, "ada@example.com", "")
            .iter()
            .all(|e| !e.subject.ends_with("left this month")),
        "a limit of 2 never warns"
    );

    c.patch(
        "/v1/profile",
        json!({ "notifications": { "running_low": false } }),
    )
    .await;
    digest::after_application_started(&app.state, id, "pro").await;
    assert!(
        subjects_to(&app, "ada@example.com", "")
            .iter()
            .all(|e| !e.subject.ends_with("left this month")),
        "switched off"
    );
    c.patch(
        "/v1/profile",
        json!({ "notifications": { "running_low": true } }),
    )
    .await;
    digest::after_application_started(&app.state, id, "pro").await;
    assert_eq!(
        subjects_to(&app, "ada@example.com", "2 applications left").len(),
        1
    );
}

const ANDROID: &str = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

async fn sign_in_from(app: &TestApp, email: &str, ua: &str) {
    let res = app
        .request(
            Method::POST,
            "/v1/auth/signin",
            Some(json!({ "email": email, "password": "a long enough passphrase" })),
            &[("origin", APP_ORIGIN), ("user-agent", ua)],
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
}

#[tokio::test]
async fn a_sign_in_from_a_new_device_sends_an_alert() {
    let app = TestApp::spawn().await;
    verified_user(&app, "ada@example.com").await; // signed up from "no user agent"
    let alerts = || subjects_to(&app, "ada@example.com", "New sign-in");
    assert!(alerts().is_empty(), "sign-up never alerts");

    sign_in_from(&app, "ada@example.com", ANDROID).await;
    assert_eq!(alerts().len(), 1);
    let e = &alerts()[0];
    assert_eq!(e.subject, "New sign-in to Diligently: Chrome on Android");
    assert!(e.text.contains("Device: Chrome on Android"));
    assert!(e.text.contains("How: Password"));
    assert!(e.text.contains("(UTC)"));
    assert!(e.headers.is_empty(), "security email");

    sign_in_from(&app, "ada@example.com", ANDROID).await;
    assert_eq!(alerts().len(), 1, "a known device is quiet");
}

#[tokio::test]
async fn the_first_device_ever_does_not_alert() {
    let app = TestApp::spawn().await;
    verified_user(&app, "ada@example.com").await;
    sqlx::query("delete from known_devices")
        .execute(&app.state.db)
        .await
        .unwrap();
    sign_in_from(&app, "ada@example.com", MAC).await;
    assert!(subjects_to(&app, "ada@example.com", "New sign-in").is_empty());
    let n: i64 = sqlx::query_scalar("select count(*) from known_devices")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 1, "now remembered");
    sign_in_from(&app, "ada@example.com", ANDROID).await;
    assert_eq!(subjects_to(&app, "ada@example.com", "New sign-in").len(), 1);
}

#[tokio::test]
async fn device_hashes_match_the_migration_seed() {
    let app = TestApp::spawn().await;
    let rust = diligently_api::devices::device_hash(Some(ANDROID));
    let sql: Vec<u8> = sqlx::query_scalar("select sha256(convert_to($1, 'UTF8'))")
        .bind(ANDROID)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(rust, sql);
    let empty: Vec<u8> =
        sqlx::query_scalar("select sha256(convert_to(coalesce(null::text, ''), 'UTF8'))")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(diligently_api::devices::device_hash(None), empty);
}
