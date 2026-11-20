//! Every failure uses one JSON envelope: { "error": { "code", "message" } }.

mod common;

use axum::http::StatusCode;
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
    let c = signed_in(&app).await;
    let res = c.get("/v1/applications/not-a-uuid").await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn malformed_json_body_is_a_json_bad_request() {
    let app = TestApp::spawn().await;
    let c = signed_in(&app).await;
    // Valid JSON, wrong shape: jd_raw must be a string.
    let res = c.post("/v1/applications", json!({ "jd_raw": 42 })).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn unknown_id_is_a_json_not_found() {
    let app = TestApp::spawn().await;
    let c = signed_in(&app).await;
    let res = c
        .get("/v1/applications/00000000-0000-0000-0000-000000000000")
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.body["error"]["code"], "not_found");
}

#[tokio::test]
async fn the_old_shared_bearer_token_grants_nothing() {
    let app = TestApp::spawn().await;
    let auth = format!("Bearer {}", common::TEST_BEARER);
    let res = app
        .request(
            axum::http::Method::GET,
            "/v1/applications",
            None,
            &[("authorization", &auth)],
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}
