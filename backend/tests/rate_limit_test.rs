//! Auth endpoints answer 429 with Retry-After once a caller exceeds its budget.

mod common;

use axum::http::{header, StatusCode};
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn repeated_failed_signins_for_one_email_hit_429() {
    let app = TestApp::spawn().await;
    let c = app.client();
    let mut statuses = Vec::new();
    for _ in 0..12 {
        let res = c
            .post(
                "/v1/auth/signin",
                json!({ "email": "ada@example.com", "password": "wrong password!!" }),
            )
            .await;
        statuses.push(res.status);
        if res.status == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(res.body["error"]["code"], "rate_limited");
            let retry: u64 = res.headers[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse()
                .unwrap();
            assert!(retry >= 1);
            break;
        }
    }
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::UNAUTHORIZED)
            .count(),
        10
    );
    assert_eq!(statuses.last(), Some(&StatusCode::TOO_MANY_REQUESTS));
}

#[tokio::test]
async fn forgot_password_is_limited_per_email() {
    let app = TestApp::spawn().await;
    let c = app.client();
    for _ in 0..3 {
        let res = c
            .post(
                "/v1/auth/forgot-password",
                json!({ "email": "ada@example.com" }),
            )
            .await;
        assert_eq!(res.status, StatusCode::ACCEPTED);
    }
    let res = c
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "ADA@example.com" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    // Another address is unaffected.
    let res = c
        .post(
            "/v1/auth/forgot-password",
            json!({ "email": "bo@example.com" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn signup_is_limited_per_ip() {
    let app = TestApp::spawn().await;
    let mut last = StatusCode::OK;
    for i in 0..11 {
        last = app
            .client()
            .post("/v1/auth/signup", json!({ "email": format!("u{i}@example.com"), "password": "a long enough passphrase" }))
            .await
            .status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}
