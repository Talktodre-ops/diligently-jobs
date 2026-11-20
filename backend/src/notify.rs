//! Sending the account emails: who gets them, their local time, and the
//! security notices that go out after account changes. Message copy lives in
//! `crate::mail::messages`; this module looks up what the copy needs.
//!
//! Security notices are best effort. The change they report has already
//! happened, so a lookup or send failure is logged and never undoes it.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::AppError;
use crate::mail::{self, Email};
use crate::AppState;

/// The address and preferences an email is built from. Users without a
/// profile row get the profile defaults.
#[derive(Debug, Clone, FromRow)]
pub struct Recipient {
    pub email: String,
    pub verified: bool,
    pub time_zone: Option<String>,
    pub send_hour: i32,
    pub skip_weekends: bool,
    pub unsubscribe_token: String,
}

pub async fn recipient(db: &PgPool, user_id: Uuid) -> Result<Option<Recipient>, AppError> {
    Ok(sqlx::query_as::<_, Recipient>(
        r#"
        select u.email, u.email_verified_at is not null as verified, p.time_zone,
               coalesce(p.send_hour, 9) as send_hour, coalesce(p.skip_weekends, true) as skip_weekends,
               u.unsubscribe_token
        from users u left join profiles p on p.user_id = u.id
        where u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

/// "Lagos" from "Africa/Lagos", "Buenos Aires" from
/// "America/Argentina/Buenos_Aires". None for UTC or no zone.
pub fn city(time_zone: Option<&str>) -> Option<String> {
    let tz = time_zone?.trim();
    if tz.is_empty() || tz.eq_ignore_ascii_case("utc") || tz.eq_ignore_ascii_case("etc/utc") {
        return None;
    }
    Some(tz.rsplit('/').next().unwrap_or(tz).replace('_', " "))
}

/// `Mon 17 Nov, 09:14 (Lagos time)` in the user's zone, or `(UTC)` when the
/// zone is unknown. Converted by the database's time zone data.
pub async fn local_time(
    db: &PgPool,
    time_zone: Option<&str>,
    at: DateTime<Utc>,
) -> Result<String, AppError> {
    let tz = time_zone.unwrap_or("UTC");
    let s: String =
        sqlx::query_scalar("select to_char($1 at time zone $2, 'Dy FMDD Mon, HH24:MI')")
            .bind(at)
            .bind(tz)
            .fetch_one(db)
            .await?;
    Ok(match city(time_zone) {
        Some(c) => format!("{s} ({c} time)"),
        None => format!("{s} (UTC)"),
    })
}

/// "9:00" for a send hour.
pub fn send_time(hour: i32) -> String {
    format!("{hour}:00")
}

/// A short device name from a user agent, the same rule the web uses for
/// the signed-in devices list.
pub fn device_name(user_agent: Option<&str>) -> String {
    let Some(ua) = user_agent.filter(|s| !s.trim().is_empty()) else {
        return "Unknown device".to_string();
    };
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    let os = if ua.contains("Android") {
        "Android"
    } else if ua.contains("iPhone") || ua.contains("iPad") {
        "iOS"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") {
        "macOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() {
        browser.to_string()
    } else {
        format!("{browser} on {os}")
    }
}

fn key(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

/// Look the user up, build a security email with their local time, send it.
async fn security(
    state: &AppState,
    user_id: Uuid,
    what: &str,
    build: impl FnOnce(&Recipient, &str) -> Email,
) {
    let built = async {
        let r = recipient(&state.db, user_id)
            .await?
            .ok_or(AppError::NotFound)?;
        let when = local_time(&state.db, r.time_zone.as_deref(), Utc::now()).await?;
        Ok::<Email, AppError>(build(&r, &when))
    }
    .await;
    match built {
        Ok(email) => mail::send_best_effort(state.mailer.as_ref(), email).await,
        Err(e) => tracing::error!(%user_id, what, error = %e, "security email not built"),
    }
}

pub async fn password_changed(
    state: &AppState,
    user_id: Uuid,
    user_agent: Option<&str>,
    first_password: bool,
) {
    let app = state.config.web.app_base_url.clone();
    let device = device_name(user_agent);
    security(state, user_id, "password_changed", |r, when| {
        mail::password_changed(
            &r.email,
            &app,
            when,
            &device,
            first_password,
            key("pwchanged"),
        )
    })
    .await;
}

/// To the address the account used before the change.
pub async fn email_changed(state: &AppState, user_id: Uuid, old_email: &str, new_email: &str) {
    let app = state.config.web.app_base_url.clone();
    let support = state.config.support_email.clone();
    security(state, user_id, "email_changed", |_, when| {
        mail::email_changed(
            old_email,
            new_email,
            &app,
            when,
            support.as_deref(),
            key("emailchanged"),
        )
    })
    .await;
}

pub async fn google_connected(state: &AppState, user_id: Uuid, google_email: &str) {
    let app = state.config.web.app_base_url.clone();
    security(state, user_id, "google_connected", |r, when| {
        mail::google_connected(&r.email, google_email, &app, when, key("gconnected"))
    })
    .await;
}

pub async fn google_disconnected(state: &AppState, user_id: Uuid) {
    let app = state.config.web.app_base_url.clone();
    security(state, user_id, "google_disconnected", |r, when| {
        mail::google_disconnected(&r.email, &app, when, key("gdisconnected"))
    })
    .await;
}

/// After the account is gone: the address and zone are read before deleting.
pub async fn account_deleted(state: &AppState, r: &Recipient) {
    let when = match local_time(&state.db, r.time_zone.as_deref(), Utc::now()).await {
        Ok(w) => w,
        Err(e) => {
            tracing::error!(error = %e, "account deleted email not built");
            return;
        }
    };
    let email = mail::account_deleted(
        &r.email,
        &state.config.web.app_base_url,
        &when,
        state.config.support_email.as_deref(),
        key("deleted"),
    );
    mail::send_best_effort(state.mailer.as_ref(), email).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn city_names_read_naturally() {
        assert_eq!(city(Some("Africa/Lagos")).as_deref(), Some("Lagos"));
        assert_eq!(
            city(Some("America/Argentina/Buenos_Aires")).as_deref(),
            Some("Buenos Aires")
        );
        assert_eq!(city(Some("UTC")), None);
        assert_eq!(city(None), None);
    }

    #[test]
    fn device_names_match_the_web() {
        let chrome_android = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
        assert_eq!(device_name(Some(chrome_android)), "Chrome on Android");
        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0";
        assert_eq!(device_name(Some(edge)), "Edge on Windows");
        let safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
        assert_eq!(device_name(Some(safari)), "Safari on iOS");
        assert_eq!(device_name(Some("curl/8.0")), "Browser");
        assert_eq!(device_name(None), "Unknown device");
    }
}
