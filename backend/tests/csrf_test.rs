//! Unsafe requests must come from an allowed origin.

mod common;

use axum::http::{Method, StatusCode};
use common::{TestApp, APP_ORIGIN};
use serde_json::json;

#[tokio::test]
async fn post_without_origin_or_referer_is_refused() {
    let app = TestApp::spawn().await;
    let res = app
        .request(
            Method::POST,
            "/v1/applications",
            Some(json!({"jd_raw": "x"})),
            &[],
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.body["error"]["code"], "origin_not_allowed");
}

#[tokio::test]
async fn post_from_a_foreign_origin_is_refused() {
    let app = TestApp::spawn().await;
    let res = app
        .request(
            Method::POST,
            "/v1/applications",
            Some(json!({"jd_raw": "x"})),
            &[("origin", "https://evil.example")],
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.body["error"]["code"], "origin_not_allowed");
}

#[tokio::test]
async fn referer_from_the_app_counts_when_origin_is_absent() {
    let app = TestApp::spawn().await;
    let referer = format!("{APP_ORIGIN}/jobs/new");
    let res = app
        .request(
            Method::POST,
            "/v1/applications",
            Some(json!({"jd_raw": "x"})),
            &[("referer", &referer)],
        )
        .await;
    // Past the origin check; refused only for lacking credentials.
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn safe_methods_skip_the_origin_check() {
    let app = TestApp::spawn().await;
    let res = app.get("/health").await;
    assert_eq!(res.status, StatusCode::OK);
}
