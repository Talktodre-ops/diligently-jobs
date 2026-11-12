//! Server-side sessions carried by an HttpOnly cookie.
//!
//! Sliding expiry: a session lives `IDLE_TTL` past its last use, capped at
//! `ABSOLUTE_TTL` from sign-in. Revoking is deleting the row, which takes
//! effect on the very next request.

use axum::http::{header, HeaderMap, HeaderValue};
use chrono::{DateTime, Duration, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use super::token;
use crate::config::WebConfig;
use crate::error::AppError;

pub const COOKIE_NAME: &str = "dl_session";
pub const IDLE_TTL: Duration = Duration::days(30);
pub const ABSOLUTE_TTL: Duration = Duration::days(90);
/// Only write `last_seen_at` when it is older than this, so ordinary reads do
/// not turn every request into a database write.
const TOUCH_AFTER: Duration = Duration::hours(1);

#[derive(Debug, Clone, FromRow)]
pub struct SessionUser {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub email: String,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub plan: String,
    pub last_seen_at: DateTime<Utc>,
    pub absolute_expires_at: DateTime<Utc>,
}

/// Create a session and return the raw token for the cookie.
pub async fn create(
    db: &PgPool,
    user_id: Uuid,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<String, AppError> {
    let raw = token::generate();
    let now = Utc::now();
    sqlx::query(
        r#"
        insert into sessions (user_id, token_hash, user_agent, ip, expires_at, absolute_expires_at)
        values ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(user_id)
    .bind(token::hash(&raw))
    .bind(user_agent.map(|s| s.chars().take(300).collect::<String>()))
    .bind(ip)
    .bind(now + IDLE_TTL)
    .bind(now + ABSOLUTE_TTL)
    .execute(db)
    .await?;
    Ok(raw)
}

/// Resolve a raw cookie token to its live session and user, sliding the
/// expiry forward when due. Expired or unknown tokens resolve to `None`.
pub async fn lookup(db: &PgPool, raw: &str) -> Result<Option<SessionUser>, AppError> {
    if !token::looks_valid(raw) {
        return Ok(None);
    }
    let found = sqlx::query_as::<_, SessionUser>(
        r#"
        select s.id as session_id, u.id as user_id, u.email, u.email_verified_at, u.plan,
               s.last_seen_at, s.absolute_expires_at
        from sessions s
        join users u on u.id = s.user_id
        where s.token_hash = $1
          and s.expires_at > now()
          and s.absolute_expires_at > now()
        "#,
    )
    .bind(token::hash(raw))
    .fetch_optional(db)
    .await?;

    if let Some(s) = &found {
        let now = Utc::now();
        if now - s.last_seen_at > TOUCH_AFTER {
            let next = std::cmp::min(now + IDLE_TTL, s.absolute_expires_at);
            sqlx::query("update sessions set last_seen_at = $2, expires_at = $3 where id = $1")
                .bind(s.session_id)
                .bind(now)
                .bind(next)
                .execute(db)
                .await?;
        }
    }
    Ok(found)
}

pub async fn revoke(db: &PgPool, session_id: Uuid) -> Result<(), AppError> {
    sqlx::query("delete from sessions where id = $1")
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Revoke every session for the user except `keep` (the current device).
pub async fn revoke_all_except(
    db: &PgPool,
    user_id: Uuid,
    keep: Option<Uuid>,
) -> Result<u64, AppError> {
    let res =
        sqlx::query("delete from sessions where user_id = $1 and ($2::uuid is null or id <> $2)")
            .bind(user_id)
            .bind(keep)
            .execute(db)
            .await?;
    Ok(res.rows_affected())
}

/// Read the session token from the Cookie header, if present.
pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value.trim().to_string())
}

/// Set-Cookie value that stores the session token.
pub fn set_cookie(web: &WebConfig, raw: &str) -> HeaderValue {
    cookie_value(web, raw, ABSOLUTE_TTL.num_seconds())
}

/// Set-Cookie value that removes the session cookie.
pub fn clear_cookie(web: &WebConfig) -> HeaderValue {
    cookie_value(web, "", 0)
}

fn cookie_value(web: &WebConfig, value: &str, max_age: i64) -> HeaderValue {
    let secure = if web.cookie_secure { "; Secure" } else { "" };
    let s =
        format!("{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}");
    // The token is base64url and the rest is fixed ASCII, so this cannot fail.
    HeaderValue::from_str(&s).expect("cookie header is ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web(secure: bool) -> WebConfig {
        WebConfig {
            app_base_url: "https://app.example".into(),
            allowed_origins: vec!["https://app.example".into()],
            cookie_secure: secure,
            trust_proxy: false,
        }
    }

    #[test]
    fn cookie_has_safe_flags() {
        let v = set_cookie(&web(true), "tok");
        let s = v.to_str().unwrap();
        assert!(s.starts_with("dl_session=tok;"));
        for flag in ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"] {
            assert!(s.contains(flag), "missing {flag}: {s}");
        }
        assert!(!set_cookie(&web(false), "tok")
            .to_str()
            .unwrap()
            .contains("Secure"));
        assert!(clear_cookie(&web(true))
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
    }

    #[test]
    fn reads_token_among_other_cookies() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; dl_session=abc; b=2"),
        );
        assert_eq!(token_from_headers(&h).as_deref(), Some("abc"));
        let empty = HeaderMap::new();
        assert_eq!(token_from_headers(&empty), None);
    }
}
