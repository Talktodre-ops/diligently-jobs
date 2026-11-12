//! Response headers, body limits, CORS and the database statement timeout.

mod common;

use axum::http::{header, Method, StatusCode};
use common::{TestApp, APP_ORIGIN};
use serde_json::json;

#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let app = TestApp::spawn().await;
    for res in [app.get("/health").await, app.get("/v1/applications").await] {
        let h = &res.headers;
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(
            h[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; frame-ancestors 'none'"
        );
        assert!(h[header::STRICT_TRANSPORT_SECURITY]
            .to_str()
            .unwrap()
            .starts_with("max-age="));
        assert_eq!(h[header::CACHE_CONTROL], "no-store");
    }
}

#[tokio::test]
async fn no_hsts_when_cookies_are_not_secure() {
    let app = TestApp::spawn_with(|c| c.web.cookie_secure = false).await;
    assert!(app
        .get("/health")
        .await
        .headers
        .get(header::STRICT_TRANSPORT_SECURITY)
        .is_none());
}

#[tokio::test]
async fn oversized_json_bodies_are_refused_with_413() {
    let app = TestApp::spawn().await;
    let c = app.client();
    let big = "x".repeat(1024 * 1024 + 10);
    let res = c
        .post(
            "/v1/auth/signin",
            json!({ "email": "a@b.co", "password": big }),
        )
        .await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.body["error"]["code"], "too_large");
}

#[tokio::test]
async fn cors_allows_only_the_configured_origin_with_credentials() {
    let app = TestApp::spawn().await;
    let preflight = [
        ("access-control-request-method", "POST"),
        ("access-control-request-headers", "content-type"),
    ];
    let ok = app
        .request(
            Method::OPTIONS,
            "/v1/applications",
            None,
            &[("origin", APP_ORIGIN), preflight[0], preflight[1]],
        )
        .await;
    assert_eq!(ok.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], APP_ORIGIN);
    assert_eq!(ok.headers[header::ACCESS_CONTROL_ALLOW_CREDENTIALS], "true");
    let evil = app
        .request(
            Method::OPTIONS,
            "/v1/applications",
            None,
            &[
                ("origin", "https://evil.example"),
                preflight[0],
                preflight[1],
            ],
        )
        .await;
    assert!(evil
        .headers
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .is_none());
}

#[tokio::test]
async fn pooled_connections_have_a_statement_timeout() {
    let url = std::env::var("TEST_DATABASE_URL").unwrap();
    let pool = diligently_api::db::init_pool(&url).await.unwrap();
    let t: String = sqlx::query_scalar("show statement_timeout")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(t, "30s");
}
