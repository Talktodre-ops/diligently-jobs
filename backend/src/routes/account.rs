//! Settings: download my data, delete my account, set a password, and
//! disconnect Google.

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;
use uuid::Uuid;

use crate::auth::{code, password, session, CurrentUser};
use crate::error::AppError;
use crate::extract::Json;
use crate::rate_limit;
use crate::AppState;

/// Tables exported per user (key in the file, table, ordering column). Internal
/// tables (sessions, email tokens, jobs) and secrets (password hash) are left
/// out; user_id is dropped from every row since it is the same throughout.
const EXPORTED: &[(&str, &str, &str)] = &[
    ("profile", "profiles", "created_at"),
    ("cv_versions", "cv_versions", "created_at"),
    ("cv_uploads", "cv_uploads", "created_at"),
    ("applications", "applications", "created_at"),
    ("gaps", "application_gaps", "created_at"),
    ("rewrites", "tailored_bullets", "created_at"),
    ("ats_scores", "ats_scores", "created_at"),
    ("company_research", "company_research", "created_at"),
    ("cover_letters", "cover_letters", "generated_at"),
    ("follow_ups", "follow_ups", "created_at"),
    ("reminders", "reminders", "created_at"),
    ("interviews", "interviews", "created_at"),
    ("chat_conversations", "chat_conversations", "created_at"),
    ("gap_analyses", "gap_analyses", "created_at"),
    ("events", "events", "created_at"),
    ("ai_usage", "ai_usage", "created_at"),
];

const LINK_TTL: Duration = Duration::from_secs(60 * 60);

/// GET /v1/account/export: everything the user owns as one JSON download,
/// with hour-long links to their stored files.
pub async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(rate_limit::EXPORT_USER, &user.id.to_string())?;
    let mut out = Map::new();
    let account: Value = sqlx::query_scalar(
        r#"
        select jsonb_build_object('email', email, 'email_verified_at', email_verified_at, 'plan', plan,
                                  'created_at', created_at, 'last_sign_in_at', last_sign_in_at)
        from users where id = $1
        "#,
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;
    out.insert("exported_at".into(), json!(chrono::Utc::now()));
    out.insert("account".into(), account);
    for (name, table, order) in EXPORTED {
        // Table names come from the constant above, never from input.
        let rows: Value = sqlx::query_scalar(&format!(
            "select coalesce(jsonb_agg(to_jsonb(t) - 'user_id' order by t.{order}), '[]'::jsonb) from {table} t where t.user_id = $1"
        ))
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
        out.insert((*name).to_string(), rows);
    }
    let keys = state.r2.list_keys(&format!("u/{}/", user.id)).await?;
    let mut files = Vec::new();
    for k in keys {
        let url = state.r2.presign_get(&k, LINK_TTL, None).await?;
        files.push(json!({ "key": k, "url": url }));
    }
    out.insert(
        "files".into(),
        json!({ "links_expire_in_seconds": LINK_TTL.as_secs(), "items": files }),
    );

    let body = serde_json::to_vec_pretty(&Value::Object(out)).map_err(anyhow::Error::from)?;
    let name = format!(
        "diligently-export-{}.json",
        chrono::Utc::now().format("%Y-%m-%d")
    );
    let mut resp = (StatusCode::OK, body).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
            .map_err(anyhow::Error::from)?,
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

/// Whether the user has a password and a connected Google account.
async fn sign_in_methods(state: &AppState, uid: Uuid) -> Result<(bool, bool), AppError> {
    Ok(sqlx::query_as(
        "select password_hash is not null, google_sub is not null from users where id = $1",
    )
    .bind(uid)
    .fetch_one(&state.db)
    .await?)
}

fn has_password_conflict() -> AppError {
    AppError::conflict(
        "has_password",
        "You already have a password. Change it instead.",
    )
}

/// POST /v1/account/set-password-link: for an account without a password,
/// email the "Set a password" link to the existing reset page.
pub async fn set_password_link(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(rate_limit::RESEND_USER, &user.id.to_string())?;
    let (has_password, _) = sign_in_methods(&state, user.id).await?;
    if has_password {
        return Err(has_password_conflict());
    }
    crate::auth::routes::send_reset_link(&state, user.id, &user.email, false).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// POST /v1/account/google/disconnect. Needs a password, or the account
/// would have no way to sign in.
pub async fn disconnect_google(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    let (has_password, connected) = sign_in_methods(&state, user.id).await?;
    if !has_password {
        return Err(AppError::conflict(
            "password_required",
            "Set a password first, so you can still sign in without Google.",
        ));
    }
    if connected {
        sqlx::query("update users set google_sub = null where id = $1")
            .bind(user.id)
            .execute(&state.db)
            .await?;
        crate::notify::google_disconnected(&state, user.id).await;
    }
    let u = crate::auth::routes::load_user(&state.db, user.id).await?;
    Ok(Json(crate::auth::routes::UserEnvelope { user: u.into() }).into_response())
}

/// POST /v1/account/delete-code: email a 6-digit code that deletes an
/// account without a password. Replaces any earlier delete code.
pub async fn delete_code(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(rate_limit::RESEND_USER, &user.id.to_string())?;
    let (has_password, _) = sign_in_methods(&state, user.id).await?;
    if has_password {
        return Err(has_password_conflict());
    }
    let c = code::issue(&state.db, user.id, code::Purpose::Delete).await?;
    let msg = crate::mail::delete_code(&user.email, &c, format!("delcode-{}", Uuid::new_v4()));
    crate::mail::send_best_effort(state.mailer.as_ref(), msg).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `{ password }` for an account with a password; `{ code }` (from
/// `delete-code`) for one without.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteRequest {
    pub password: Option<String>,
    pub code: Option<String>,
}

/// DELETE /v1/account: needs the password, or the emailed code when the
/// account has no password. Removes every row the user owns (one delete,
/// cascading through every table) and then their stored files, and sends a
/// last email saying so. Storage failures are logged with the prefix for
/// manual cleanup; the account itself is already gone at that point.
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<DeleteRequest>,
) -> Result<Response, AppError> {
    state
        .limiter
        .check(rate_limit::PASSWORD_CHECK_USER, &user.id.to_string())?;
    let phc: Option<String> = sqlx::query_scalar("select password_hash from users where id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    match phc {
        Some(phc) => {
            let given = req.password.unwrap_or_default();
            let ok = given.chars().count() <= password::MAX_LEN
                && password::verify(&given, &phc).await?;
            if !ok {
                return Err(AppError::validation(
                    "password",
                    "That password is not right.",
                ));
            }
        }
        None => {
            state
                .limiter
                .check(rate_limit::VERIFY_CODE_USER, &user.id.to_string())?;
            let wrong = || {
                AppError::bad_field(
                    "invalid_code",
                    "code",
                    "That code is not right. Check the email and try again.",
                )
            };
            let given = req.code.ok_or_else(wrong)?;
            match code::check(&state.db, user.id, code::Purpose::Delete, given.trim()).await? {
                code::Check::Matched => {}
                code::Check::Wrong => return Err(wrong()),
                code::Check::Gone => {
                    return Err(AppError::coded(
                        StatusCode::GONE,
                        "code_expired",
                        "This code has expired. Ask for a new one.",
                    ))
                }
            }
        }
    }
    let recipient = crate::notify::recipient(&state.db, user.id).await?;
    delete_user(&state, user.id).await?;
    if let Some(r) = recipient {
        crate::notify::account_deleted(&state, &r).await;
    }
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, session::clear_cookie(&state.config.web));
    Ok(resp)
}

pub async fn delete_user(state: &AppState, uid: Uuid) -> Result<(), AppError> {
    sqlx::query("delete from users where id = $1")
        .bind(uid)
        .execute(&state.db)
        .await?;
    let prefix = format!("u/{uid}/");
    match state.r2.delete_prefix(&prefix).await {
        Ok((n, 0)) => tracing::info!(deleted = n, "account deleted with its files"),
        Ok((n, failed)) => {
            tracing::error!(%prefix, deleted = n, failed, "account deleted; some files remain")
        }
        Err(e) => {
            tracing::error!(%prefix, error = %format!("{e:#}"), "account deleted; file cleanup failed")
        }
    }
    Ok(())
}
