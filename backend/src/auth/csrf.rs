//! CSRF defence for cookie-authenticated requests.
//!
//! SameSite=Lax already stops cross-site POSTs carrying the cookie in modern
//! browsers; this check is the second layer. Every unsafe method must come
//! from an allowed origin, judged by the Origin header, or by Referer when a
//! browser omits Origin. A request with neither is refused.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method};
use axum::middleware::Next;
use axum::response::Response;

use crate::error::AppError;
use crate::AppState;

pub async fn require_allowed_origin(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    if is_safe(req.method()) || has_bearer(req.headers()) {
        return Ok(next.run(req).await);
    }
    match request_origin(req.headers()) {
        Some(origin) if state.config.web.allowed_origins.contains(&origin) => {
            Ok(next.run(req).await)
        }
        _ => Err(AppError::forbidden(
            "origin_not_allowed",
            "This request did not come from the Diligently app.",
        )),
    }
}

fn is_safe(m: &Method) -> bool {
    matches!(*m, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// Bearer-token clients (the frozen desktop app) do not use cookies, so CSRF
/// does not apply to them. This exemption goes away with bearer auth.
fn has_bearer(h: &HeaderMap) -> bool {
    h.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("Bearer "))
}

/// `scheme://host[:port]` from Origin, falling back to Referer.
pub fn request_origin(h: &HeaderMap) -> Option<String> {
    if let Some(o) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if o != "null" {
            return Some(o.trim_end_matches('/').to_string());
        }
        return None;
    }
    let referer = h.get(header::REFERER)?.to_str().ok()?;
    let (scheme, rest) = referer.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn origin_prefers_origin_header_then_referer() {
        let mut h = HeaderMap::new();
        h.insert(
            header::REFERER,
            HeaderValue::from_static("https://app.example/jobs?x=1"),
        );
        assert_eq!(request_origin(&h).as_deref(), Some("https://app.example"));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://other.example"),
        );
        assert_eq!(request_origin(&h).as_deref(), Some("https://other.example"));
    }

    #[test]
    fn null_or_missing_origin_is_none() {
        let mut h = HeaderMap::new();
        assert_eq!(request_origin(&h), None);
        h.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert_eq!(request_origin(&h), None);
    }
}
