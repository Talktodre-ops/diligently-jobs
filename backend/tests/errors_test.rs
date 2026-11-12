//! Every failure uses one JSON envelope: { "error": { "code", "message" } }.

mod common;

use axum::http::{Method, StatusCode};
use common::{TestApp, TEST_BEARER};
use serde_json::json;

fn bearer() -> String {
    format!("Bearer {TEST_BEARER}")
}

#[tokio::test]
async fn missing_credentials_use_the_error_envelope() {
    let app = TestApp::spawn().await;
    let res = app.get("/v1/applications").await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.body["error"]["code"], "unauthorized");
    assert!(res.body["error"]["message"].is_string());
}

#[tokio::test]
async fn malformed_path_uuid_is_a_json_bad_request() {
    let app = TestApp::spawn().await;
    let auth = bearer();
    let res = app
        .request(
            Method::GET,
            "/v1/applications/not-a-uuid",
            None,
            &[("authorization", &auth)],
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        res.body["error"]["code"],
        "bad_request",
        "body: {:?}",
        String::from_utf8_lossy(&res.raw)
    );
}

#[tokio::test]
async fn malformed_json_body_is_a_json_bad_request() {
    let app = TestApp::spawn().await;
    let auth = bearer();
    // Valid JSON, wrong shape: jd_raw must be a string.
    let res = app
        .request(
            Method::POST,
            "/v1/applications",
            Some(json!({ "jd_raw": 42 })),
            &[("authorization", &auth)],
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn unknown_id_is_a_json_not_found() {
    let app = TestApp::spawn().await;
    let auth = bearer();
    let res = app
        .request(
            Method::GET,
            "/v1/applications/00000000-0000-0000-0000-000000000000",
            None,
            &[("authorization", &auth)],
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.body["error"]["code"], "not_found");
}
