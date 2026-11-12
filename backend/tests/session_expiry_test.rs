//! Sessions slide forward on use but never past the absolute cap.

mod common;

use axum::http::StatusCode;
use chrono::{DateTime, Duration, Utc};
use common::TestApp;
use serde_json::json;

async fn signed_in(app: &TestApp) -> common::Client<'_> {
    let c = app.client();
    let res = c
        .post(
            "/v1/auth/signup",
            json!({ "email": "ada@example.com", "password": "a long enough passphrase" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    c
}

async fn expiry(app: &TestApp) -> DateTime<Utc> {
    sqlx::query_scalar("select expires_at from sessions")
        .fetch_one(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn use_after_an_hour_slides_the_expiry() {
    let app = TestApp::spawn().await;
    let c = signed_in(&app).await;
    sqlx::query(
        "update sessions set last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 day'",
    )
    .execute(&app.state.db)
    .await
    .unwrap();

    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::OK);
    let after = expiry(&app).await;
    assert!(
        after > Utc::now() + Duration::days(29),
        "slid to ~30 days: {after}"
    );
}

#[tokio::test]
async fn sliding_never_passes_the_absolute_cap() {
    let app = TestApp::spawn().await;
    let c = signed_in(&app).await;
    sqlx::query(
        "update sessions set last_seen_at = now() - interval '2 hours', absolute_expires_at = now() + interval '3 days'",
    )
    .execute(&app.state.db)
    .await
    .unwrap();

    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::OK);
    let after = expiry(&app).await;
    assert!(after <= Utc::now() + Duration::days(3), "capped: {after}");

    sqlx::query("update sessions set absolute_expires_at = now() - interval '1 second'")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(c.get("/v1/auth/me").await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn recent_use_does_not_write_on_every_request() {
    let app = TestApp::spawn().await;
    let c = signed_in(&app).await;
    let before = expiry(&app).await;
    c.get("/v1/auth/me").await;
    assert_eq!(expiry(&app).await, before);
}
