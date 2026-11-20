//! /health reports Postgres and object storage status without auth.

mod common;

use axum::http::StatusCode;
use common::TestApp;

#[tokio::test]
async fn health_reports_postgres_and_storage_ok() {
    let app = TestApp::spawn().await;
    let res = app.get("/health").await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["status"], "ok", "body: {}", res.body);
    assert_eq!(res.body["postgres"]["ok"], true);
    assert_eq!(res.body["r2"]["ok"], true);
}

#[tokio::test]
async fn protected_route_without_credentials_is_rejected() {
    let app = TestApp::spawn().await;
    let res = app.get("/v1/applications").await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}
