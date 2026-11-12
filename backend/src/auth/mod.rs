//! Authentication: password accounts, cookie sessions, CSRF origin checks.
//!
//! Handlers take `CurrentUser` (any signed-in user) or `VerifiedUser` (email
//! confirmed, required for anything that spends AI budget) as an argument;
//! the extractor rejects with 401/403 before the handler runs.

pub mod bearer;
pub mod csrf;
pub mod password;
pub mod routes;
pub mod session;
pub mod token;

pub use bearer::require_bearer;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap};
use chrono::{DateTime, Utc};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::error::AppError;
use crate::AppState;

#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: Uuid,
    pub email: String,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub plan: String,
    pub session_id: Uuid,
}

impl CurrentUser {
    pub fn is_verified(&self) -> bool {
        self.email_verified_at.is_some()
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        // Resolve once per request even if several extractors ask.
        if let Some(user) = parts.extensions.get::<CurrentUser>() {
            return Ok(user.clone());
        }
        let raw = session::token_from_headers(&parts.headers)
            .ok_or(AppError::Unauthorized("Sign in to continue."))?;
        let s = session::lookup(&state.db, &raw)
            .await?
            .ok_or(AppError::Unauthorized(
                "Your session has ended. Sign in again.",
            ))?;
        let user = CurrentUser {
            id: s.user_id,
            email: s.email,
            email_verified_at: s.email_verified_at,
            plan: s.plan,
            session_id: s.session_id,
        };
        parts.extensions.insert(user.clone());
        Ok(user)
    }
}

/// A signed-in user whose email is confirmed.
#[derive(Debug, Clone)]
pub struct VerifiedUser(pub CurrentUser);

impl FromRequestParts<AppState> for VerifiedUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if !user.is_verified() {
            return Err(AppError::forbidden(
                "email_not_verified",
                "Confirm your email address to use this.",
            ));
        }
        Ok(VerifiedUser(user))
    }
}

/// Client IP for rate limiting and the session list. With `trust_proxy`, the
/// last X-Forwarded-For entry (the one our own proxy appended) wins; otherwise
/// the socket peer address. Never trust more than one hop.
pub fn client_ip(
    headers: &HeaderMap,
    peer: Option<&ConnectInfo<SocketAddr>>,
    trust_proxy: bool,
) -> Option<String> {
    if trust_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(ip.to_string());
        }
    }
    peer.map(|ConnectInfo(addr)| addr.ip().to_string())
}

pub fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn client_ip_ignores_forwarded_header_unless_trusted() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.6, 10.0.0.1"),
        );
        let peer = ConnectInfo("127.0.0.1:5000".parse::<SocketAddr>().unwrap());
        assert_eq!(
            client_ip(&h, Some(&peer), false).as_deref(),
            Some("127.0.0.1")
        );
        // Trusted: the last hop is the one our proxy wrote; the first is client-controlled.
        assert_eq!(
            client_ip(&h, Some(&peer), true).as_deref(),
            Some("10.0.0.1")
        );
        assert_eq!(client_ip(&HeaderMap::new(), None, true), None);
    }
}
