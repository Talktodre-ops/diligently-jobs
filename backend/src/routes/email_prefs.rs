//! Unsubscribe from one kind of optional email without signing in.
//!
//! Every optional email carries the user's unsubscribe token: a footer link
//! to the web page (which calls `unsubscribe` and offers Undo through
//! `resubscribe`) and an RFC 8058 List-Unsubscribe header that mail clients
//! post to `one_click`. The token only toggles email preferences, so these
//! routes need no session and no CSRF check; they are rate limited per IP.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::routes::ClientMeta;
use crate::error::AppError;
use crate::extract::{Json, Query};
use crate::rate_limit;
use crate::AppState;

pub const KINDS: &[&str] = &[
    "follow_ups",
    "weekly_summary",
    "running_low",
    "product_news",
];

/// The profile column behind each kind. Only these constants reach SQL.
fn column(kind: &str) -> Option<&'static str> {
    match kind {
        "follow_ups" => Some("notify_follow_ups"),
        "weekly_summary" => Some("notify_weekly_summary"),
        "running_low" => Some("notify_running_low"),
        "product_news" => Some("notify_product_news"),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
pub struct TokenKind {
    pub token: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct Done {
    pub kind: String,
    /// The address, masked: `ad***@gmail.com`.
    pub email: String,
}

/// `ad***@gmail.com` from `ada.okafor@gmail.com`: enough to recognise, not
/// enough to harvest.
pub fn mask_email(email: &str) -> String {
    let (local, domain) = email.split_once('@').unwrap_or((email, ""));
    let keep = if local.chars().count() > 2 { 2 } else { 1 };
    let shown: String = local.chars().take(keep).collect();
    if domain.is_empty() {
        format!("{shown}***")
    } else {
        format!("{shown}***@{domain}")
    }
}

/// Turn one kind on or off for the token's owner.
async fn set(
    state: &AppState,
    meta: &ClientMeta,
    req: &TokenKind,
    on: bool,
) -> Result<Done, AppError> {
    state
        .limiter
        .check(rate_limit::UNSUBSCRIBE_IP, meta.ip_key())?;
    let col = column(&req.kind).ok_or_else(|| {
        AppError::bad_field(
            "invalid_kind",
            "kind",
            format!("kind must be one of: {}", KINDS.join(", ")),
        )
    })?;
    let token = req.token.trim();
    if token.is_empty() || token.len() > 128 {
        return Err(AppError::NotFound);
    }
    let (user_id, email): (Uuid, String) =
        sqlx::query_as("select id, email from users where unsubscribe_token = $1")
            .bind(token)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    crate::routes::profile::ensure(&state.db, user_id).await?;
    sqlx::query(&format!(
        "update profiles set {col} = $2 where user_id = $1"
    ))
    .bind(user_id)
    .bind(on)
    .execute(&state.db)
    .await?;
    tracing::info!(%user_id, kind = %req.kind, on, "email preference changed by link");
    Ok(Done {
        kind: req.kind.clone(),
        email: mask_email(&email),
    })
}

/// POST /v1/email/unsubscribe `{ token, kind }`
pub async fn unsubscribe(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<TokenKind>,
) -> Result<Json<Done>, AppError> {
    set(&state, &meta, &req, false).await.map(Json)
}

/// POST /v1/email/resubscribe `{ token, kind }`: the Undo button.
pub async fn resubscribe(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(req): Json<TokenKind>,
) -> Result<Json<Done>, AppError> {
    set(&state, &meta, &req, true).await.map(Json)
}

/// POST /v1/email/unsubscribe/one-click?token=&kind= with the form body
/// `List-Unsubscribe=One-Click` (RFC 8058). The body carries nothing we need,
/// so it is not read. 200 with an empty body.
pub async fn one_click(
    State(state): State<AppState>,
    meta: ClientMeta,
    Query(req): Query<TokenKind>,
) -> Result<Response, AppError> {
    set(&state, &meta, &req, false).await?;
    Ok(StatusCode::OK.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_keep_two_letters_and_the_domain() {
        assert_eq!(mask_email("ada.okafor@gmail.com"), "ad***@gmail.com");
        assert_eq!(mask_email("ab@x.io"), "a***@x.io");
        assert_eq!(mask_email("a@x.io"), "a***@x.io");
    }

    #[test]
    fn every_kind_has_a_column() {
        for k in KINDS {
            assert!(column(k).is_some(), "{k}");
        }
        assert!(column("interview_prep").is_none());
    }
}
