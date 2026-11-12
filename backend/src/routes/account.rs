//! Settings: download my data, and delete my account.

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;
use uuid::Uuid;

use crate::auth::{password, session, CurrentUser};
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteRequest {
    pub password: String,
}

/// DELETE /v1/account: needs the password. Removes every row the user owns
/// (one delete, cascading through every table) and then their stored files.
/// Storage failures are logged with the prefix for manual cleanup; the
/// account itself is already gone at that point.
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
    let ok = match phc {
        Some(phc) if req.password.chars().count() <= password::MAX_LEN => {
            password::verify(&req.password, &phc).await?
        }
        _ => false,
    };
    if !ok {
        return Err(AppError::validation(
            "password",
            "That password is not right.",
        ));
    }
    delete_user(&state, user.id).await?;
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
