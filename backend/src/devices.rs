//! Devices a user has signed in from, and the new sign-in alert.
//!
//! A device is the SHA-256 of its user-agent string (the first 300
//! characters, as sessions store it; empty when absent), so the list holds
//! no readable browser details. A sign-in with a password or Google from a
//! device not on the list sends the alert, unless the list was empty (the
//! account's first device). Sign-ups and reset links add the device without
//! an alert.
//!
//! Like the other security emails this is best effort: a failure is logged
//! and never blocks the sign-in.

use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::AppError;
use crate::mail;
use crate::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Password,
    Google,
}

impl Method {
    fn label(self) -> &'static str {
        match self {
            Method::Password => "Password",
            Method::Google => "Google",
        }
    }
}

/// Matches the migration's seed: sha256(convert_to(coalesce(user_agent, ''), 'UTF8')).
pub fn device_hash(user_agent: Option<&str>) -> Vec<u8> {
    let ua: String = user_agent.unwrap_or("").chars().take(300).collect();
    Sha256::digest(ua.as_bytes()).to_vec()
}

/// Add the device to the list, or refresh it. True when it was new.
async fn note(state: &AppState, user_id: Uuid, user_agent: Option<&str>) -> Result<bool, AppError> {
    let hash = device_hash(user_agent);
    let inserted: Option<i32> = sqlx::query_scalar(
        r#"
        insert into known_devices (user_id, device_hash) values ($1, $2)
        on conflict (user_id, device_hash) do nothing
        returning 1
        "#,
    )
    .bind(user_id)
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    if inserted.is_none() {
        sqlx::query(
            "update known_devices set last_seen_at = now() where user_id = $1 and device_hash = $2",
        )
        .bind(user_id)
        .bind(&hash)
        .execute(&state.db)
        .await?;
    }
    Ok(inserted.is_some())
}

/// Remember the device without an alert: sign-up, a reset link, or an
/// account Google just created.
pub async fn remember(state: &AppState, user_id: Uuid, user_agent: Option<&str>) {
    if let Err(e) = note(state, user_id, user_agent).await {
        tracing::error!(%user_id, error = %e, "could not record device");
    }
}

/// After a successful sign-in: remember the device and alert the owner when
/// it is new to an account that has signed in elsewhere before.
pub async fn signed_in(
    state: &AppState,
    user_id: Uuid,
    user_agent: Option<&str>,
    ip: Option<&str>,
    method: Method,
) {
    if let Err(e) = alert_if_new(state, user_id, user_agent, ip, method).await {
        tracing::error!(%user_id, error = %e, "new sign-in check failed");
    }
}

async fn alert_if_new(
    state: &AppState,
    user_id: Uuid,
    user_agent: Option<&str>,
    ip: Option<&str>,
    method: Method,
) -> Result<(), AppError> {
    let seen_any: bool =
        sqlx::query_scalar("select exists(select 1 from known_devices where user_id = $1)")
            .bind(user_id)
            .fetch_one(&state.db)
            .await?;
    let is_new = note(state, user_id, user_agent).await?;
    if !(seen_any && is_new) {
        return Ok(());
    }
    let Some(r) = crate::notify::recipient(&state.db, user_id).await? else {
        return Ok(());
    };
    let when = crate::notify::local_time(&state.db, r.time_zone.as_deref(), Utc::now()).await?;
    let device = crate::notify::device_name(user_agent);
    let email = mail::new_sign_in(
        &r.email,
        &state.config.web.app_base_url,
        &mail::SignIn {
            device: &device,
            when: &when,
            method: method.label(),
            ip,
        },
        format!("signin-{}", Uuid::new_v4()),
    );
    mail::send_best_effort(state.mailer.as_ref(), email).await;
    Ok(())
}
