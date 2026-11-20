//! The built web app, served by the API from the same origin.
//!
//! One origin keeps the session cookie first-party and the CSRF origin check
//! simple, and lets one container run the whole product. Anything the API
//! router does not match lands here: a file from the build, or `index.html`
//! for an app route such as `/applications/abc`.
//!
//! Caching follows the build. Files under `/assets/` carry a content hash in
//! their name, so browsers keep them for a year. Pages are never stored, so a
//! deploy reaches every browser on its next load. Other public files (icons,
//! the manifest) are kept but checked every time. An `/assets/` file that no
//! longer exists answers 404 rather than the app page, so a tab left open
//! across a deploy fails a lazy import cleanly and the app reloads itself.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::error::AppError;

const ASSETS: &str = "public, max-age=31536000, immutable";
const PAGE: &str = "no-store";
const PUBLIC_FILE: &str = "public, max-age=0, must-revalidate";

#[derive(Clone, Debug)]
pub struct Site {
    dir: PathBuf,
    csp: HeaderValue,
    hsts: bool,
}

impl Site {
    /// `dir` is the web build (`npm run build` output). `file_origin` is where
    /// presigned file links point, which the page fetches to draw the PDF.
    pub fn new(dir: PathBuf, file_origin: Option<&str>, hsts: bool) -> anyhow::Result<Self> {
        anyhow::ensure!(
            dir.join("index.html").is_file(),
            "WEB_DIST {} has no index.html",
            dir.display()
        );
        let csp = HeaderValue::from_str(&content_policy(file_origin))?;
        Ok(Self { dir, csp, hsts })
    }

    pub async fn serve(&self, req: Request) -> Response {
        let path = req.uri().path().to_owned();
        // Unknown API paths keep their JSON 404; they are never the app.
        if path == "/v1" || path.starts_with("/v1/") || path == "/health" {
            return AppError::NotFound.into_response();
        }
        if req.method() != Method::GET && req.method() != Method::HEAD {
            return self.finish(StatusCode::METHOD_NOT_ALLOWED.into_response(), PAGE);
        }
        let method = req.method().clone();
        let found = self.file(req).await;
        if found.status() == StatusCode::NOT_FOUND && is_app_route(&path) {
            let index = Request::builder()
                .method(method)
                .uri("/index.html")
                .body(Body::empty())
                .expect("static request");
            let page = self.file(index).await;
            return self.finish(page, PAGE);
        }
        let cache = match found.status() {
            s if !s.is_success() && s != StatusCode::NOT_MODIFIED => PAGE,
            _ if path == "/" || path == "/index.html" => PAGE,
            _ if path.starts_with("/assets/") => ASSETS,
            _ => PUBLIC_FILE,
        };
        self.finish(found, cache)
    }

    async fn file(&self, req: Request) -> Response {
        let served = ServeDir::new(&self.dir)
            .oneshot(req)
            .await
            .expect("ServeDir is infallible");
        served.map(Body::new)
    }

    fn finish(&self, mut resp: Response, cache: &'static str) -> Response {
        set_headers(resp.headers_mut(), &self.csp, cache, self.hsts);
        resp
    }
}

fn set_headers(h: &mut HeaderMap, csp: &HeaderValue, cache: &'static str, hsts: bool) {
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    h.insert(header::CONTENT_SECURITY_POLICY, csp.clone());
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if hsts {
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
}

/// An app route is a path whose last segment has no file extension:
/// `/applications/abc` is the app, `/logo.png` and `/assets/x.js` are files.
fn is_app_route(path: &str) -> bool {
    !path.starts_with("/assets/") && !path.rsplit('/').next().unwrap_or("").contains('.')
}

/// What the page may load: its own scripts, styles and fonts, the API on the
/// same origin, the file links (to draw the PDF and prepare shares), and the
/// PDF.js worker. Inline styles are allowed because React sets style
/// attributes; inline scripts are not.
pub fn content_policy(file_origin: Option<&str>) -> String {
    let connect = match file_origin {
        Some(o) => format!("'self' {o}"),
        None => "'self'".to_string(),
    };
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; font-src 'self' data:; connect-src {connect}; \
         worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; \
         base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    )
}

/// `https://host[:port]` of a URL, or None when it is not an http(s) URL.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then(|| format!("{scheme}://{host}"))
}

/// Where the web build lives, from WEB_DIST. Unset means the API serves no
/// pages (local development, where Vite serves them).
pub fn dist_from_env() -> Option<PathBuf> {
    std::env::var("WEB_DIST")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| Path::new(v.trim()).to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_routes_are_paths_without_an_extension() {
        assert!(is_app_route("/"));
        assert!(is_app_route("/applications/abc"));
        assert!(is_app_route("/new"));
        assert!(!is_app_route("/favicon.ico"));
        assert!(!is_app_route("/assets/index-abc.js"));
        assert!(!is_app_route("/assets/fonts"));
    }

    #[test]
    fn origins_keep_scheme_host_and_port_only() {
        assert_eq!(
            origin_of("https://abc.r2.cloudflarestorage.com/bucket/key").as_deref(),
            Some("https://abc.r2.cloudflarestorage.com")
        );
        assert_eq!(
            origin_of("http://localhost:8339").as_deref(),
            Some("http://localhost:8339")
        );
        assert_eq!(origin_of("s3.test"), None);
    }

    #[test]
    fn the_policy_names_the_file_origin_for_fetches_only() {
        let p = content_policy(Some("https://files.example"));
        assert!(p.contains("connect-src 'self' https://files.example;"));
        assert!(p.contains("script-src 'self';"));
        assert!(!p.contains("unsafe-eval"));
    }
}
