//! Integration smoke test for /health.
//!
//! Marked `#[ignore]` because it hits a running server. Run with:
//!     cargo test -- --ignored
//!
//! The server must be up at $DILIGENTLY_API_URL (default http://localhost:8787)
//! before running. The justfile target `just smoke` does both: starts the
//! server in the background, runs this test, stops the server.

use serde::Deserialize;
use std::env;

#[derive(Debug, Deserialize)]
struct HealthResponse {
    status: String,
    postgres: ComponentStatus,
    r2: ComponentStatus,
}

#[derive(Debug, Deserialize)]
struct ComponentStatus {
    ok: bool,
    detail: Option<String>,
}

fn base_url() -> String {
    env::var("DILIGENTLY_API_URL").unwrap_or_else(|_| "http://localhost:8787".to_string())
}

#[tokio::test]
#[ignore]
async fn health_returns_ok_when_dependencies_are_up() {
    let url = format!("{}/health", base_url());
    let res = reqwest::get(&url)
        .await
        .unwrap_or_else(|e| panic!("could not reach {url}: {e}"));

    assert!(
        res.status().is_success(),
        "GET /health returned non-2xx: {}",
        res.status()
    );

    let body: HealthResponse = res.json().await.expect("response was not valid JSON");
    println!("[smoke] /health -> {body:#?}");

    assert!(
        body.postgres.ok,
        "Postgres unhealthy: {:?}",
        body.postgres.detail
    );
    assert!(body.r2.ok, "R2 unhealthy: {:?}", body.r2.detail);
    assert_eq!(body.status, "ok");
}

#[tokio::test]
#[ignore]
async fn health_does_not_require_bearer_token() {
    let url = format!("{}/health", base_url());
    // Send WITHOUT Authorization header. Should still succeed.
    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .unwrap_or_else(|e| panic!("could not reach {url}: {e}"));

    assert!(
        res.status().is_success(),
        "/health should be public; got {}",
        res.status()
    );
}
