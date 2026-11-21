//! The web build served from the API's origin: app routes, cache rules per
//! kind of file, the page's content policy, and API paths left alone.

use crate::common;

use axum::http::{header, Method, StatusCode};
use common::TestApp;
use std::path::PathBuf;

/// A small stand-in for `npm run build` output.
fn dist() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("diligently-dist-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><title>Diligently</title><div id=root></div>",
    )
    .unwrap();
    std::fs::write(
        dir.join("assets/index-abc123.js"),
        "export const app = 'diligently';\n".repeat(40),
    )
    .unwrap();
    std::fs::write(
        dir.join("favicon.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
    )
    .unwrap();
    dir
}

async fn with_site() -> TestApp {
    let dir = dist();
    TestApp::spawn_with(move |c| c.web_dist = Some(dir)).await
}

fn h(r: &common::TestResponse, name: header::HeaderName) -> &str {
    r.headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

#[tokio::test]
async fn app_routes_get_the_page_and_it_is_never_stored() {
    let app = with_site().await;
    for path in [
        "/",
        "/applications/abc",
        "/new?url=https%3A%2F%2Fjobs.example.com",
    ] {
        let r = app.get(path).await;
        assert_eq!(r.status, StatusCode::OK, "{path}");
        assert!(
            String::from_utf8_lossy(&r.raw).contains("<div id=root>"),
            "{path}"
        );
        assert_eq!(h(&r, header::CACHE_CONTROL), "no-store", "{path}");
        let csp = h(&r, header::CONTENT_SECURITY_POLICY);
        assert!(csp.contains("script-src 'self';"), "{csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
        assert_eq!(h(&r, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    }
}

#[tokio::test]
async fn the_page_may_fetch_file_links_and_nothing_else_off_origin() {
    let app = with_site().await;
    let r = app.get("/").await;
    let csp = h(&r, header::CONTENT_SECURITY_POLICY);
    let files = diligently_api::site::origin_of(&app.state.config.r2.endpoint).unwrap();
    assert!(
        csp.contains(&format!("connect-src 'self' {files};")),
        "{csp}"
    );
    assert!(csp.contains("worker-src 'self' blob:"), "{csp}");
}

#[tokio::test]
async fn hashed_assets_are_kept_for_a_year_and_compressed() {
    let app = with_site().await;
    let r = app
        .request(
            Method::GET,
            "/assets/index-abc123.js",
            None,
            &[("accept-encoding", "gzip")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        h(&r, header::CACHE_CONTROL),
        "public, max-age=31536000, immutable"
    );
    assert!(
        h(&r, header::CONTENT_TYPE).contains("javascript"),
        "{:?}",
        r.headers
    );
    assert_eq!(h(&r, header::CONTENT_ENCODING), "gzip");
}

#[tokio::test]
async fn a_missing_asset_is_a_404_not_the_page() {
    // A tab open across a deploy asks for the old build's chunks; a 404 lets
    // its lazy import fail cleanly so it reloads, instead of parsing HTML.
    let app = with_site().await;
    for path in ["/assets/gone-old.js", "/missing.png"] {
        let r = app.get(path).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
        assert!(
            !String::from_utf8_lossy(&r.raw).contains("<div id=root>"),
            "{path}"
        );
        assert_eq!(h(&r, header::CACHE_CONTROL), "no-store", "{path}");
    }
}

#[tokio::test]
async fn other_public_files_are_checked_every_time() {
    let app = with_site().await;
    let r = app.get("/favicon.svg").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        h(&r, header::CACHE_CONTROL),
        "public, max-age=0, must-revalidate"
    );
}

#[tokio::test]
async fn api_paths_keep_their_own_answers_and_headers() {
    let app = with_site().await;
    let r = app.get("/v1/not-a-route").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.body["error"]["code"], "not_found", "{}", r.body);
    assert_eq!(
        h(&r, header::CONTENT_SECURITY_POLICY),
        "default-src 'none'; frame-ancestors 'none'"
    );

    let r = app.get("/health").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(h(&r, header::CACHE_CONTROL), "no-store");

    let r = app.get("/v1/auth/me").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        h(&r, header::CONTENT_SECURITY_POLICY),
        "default-src 'none'; frame-ancestors 'none'"
    );
}

#[tokio::test]
async fn only_reads_reach_the_files() {
    let app = with_site().await;
    let r = app
        .request(
            Method::POST,
            "/applications/abc",
            None,
            &[("origin", common::APP_ORIGIN)],
        )
        .await;
    assert_eq!(r.status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn without_a_build_the_api_serves_no_pages() {
    let app = TestApp::spawn().await;
    assert_eq!(app.get("/").await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        app.get("/applications/abc").await.status,
        StatusCode::NOT_FOUND
    );
}
