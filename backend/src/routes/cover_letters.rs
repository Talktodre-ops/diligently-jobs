//! Cover letters (Phase 3, M2).
//!
//! Generated + edited on the desktop (AIDA structure), stored here as an
//! immutable row (newest = current). Rendering reuses the async job worker +
//! Tectonic/docx pipeline, exactly like cv_versions.

use crate::auth::{CurrentUser, VerifiedUser};
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::jobs::{self, handlers::KIND_COVER_LETTER_RENDER};
use crate::AppState;
use axum::{extract::State, http::StatusCode, response::IntoResponse};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct CoverLetter {
    pub id: Uuid,
    pub application_id: Uuid,
    pub body: String,
    pub sources: serde_json::Value,
    pub doc: Option<serde_json::Value>,
    pub r2_pdf_key: Option<String>,
    pub r2_docx_key: Option<String>,
    pub tone: String,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegenerateRequest {
    pub tone: String,
}

/// POST /v1/applications/{id}/cover-letters/regenerate: write a new letter in
/// the chosen tone (direct, warm, formal) from the current decisions, the
/// research and the gap answers. Runs inline; it takes a few seconds.
pub async fn regenerate(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    Path(application_id): Path<Uuid>,
    Json(req): Json<RegenerateRequest>,
) -> Result<Json<CoverLetter>, AppError> {
    crate::validate::one_of("tone", &req.tone, crate::prompts::cover_letter::TONES)?;
    crate::routes::ensure_application(&state.db, user.id, application_id).await?;
    let id = crate::pipeline::write_letter(&state, user.id, application_id, &req.tone).await?;
    load(&state, user.id, id).await.map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditRequest {
    pub paragraphs: Vec<String>,
}

/// PATCH /v1/cover-letters/{id}: save the user's own edits. Clears any
/// rendered files, which no longer match.
pub async fn edit(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(req): Json<EditRequest>,
) -> Result<Json<CoverLetter>, AppError> {
    let paragraphs: Vec<String> = req
        .paragraphs
        .iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paragraphs.is_empty() || paragraphs.len() > 8 {
        return Err(AppError::validation(
            "paragraphs",
            "A letter needs one to eight paragraphs.",
        ));
    }
    for p in &paragraphs {
        crate::validate::max_len("paragraphs", p, 2_000)?;
    }
    let body = paragraphs.join("\n\n");
    crate::validate::max_len("paragraphs", &body, 6_000)?;
    let res = sqlx::query(
        r#"
        update cover_letters set body = $3,
            doc = case when doc is null then null else jsonb_set(doc, '{paragraphs}', $4) end,
            r2_pdf_key = null, r2_docx_key = null
        where id = $1 and user_id = $2
        "#,
    )
    .bind(id)
    .bind(user.id)
    .bind(&body)
    .bind(json!(paragraphs))
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    load(&state, user.id, id).await.map(Json)
}

async fn load(state: &AppState, uid: Uuid, id: Uuid) -> Result<CoverLetter, AppError> {
    sqlx::query_as::<_, CoverLetter>(
        r#"
        select id, application_id, body, sources, doc, r2_pdf_key, r2_docx_key, tone, generated_at
        from cover_letters where id = $1 and user_id = $2
        "#,
    )
    .bind(id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)
}

/// GET /v1/applications/:id/cover-letters — latest one, or 404.
pub async fn get_latest(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(application_id): Path<Uuid>,
) -> Result<Json<CoverLetter>, AppError> {
    let row = sqlx::query_as::<_, CoverLetter>(
        r#"
        select id, application_id, body, sources, doc, r2_pdf_key, r2_docx_key, tone, generated_at
        from cover_letters
        where application_id = $1 and user_id = $2
        order by generated_at desc
        limit 1
        "#,
    )
    .bind(application_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(row))
}

/// POST /v1/cover-letters/:id/render
///
/// Enqueues an async render job (PDF + DOCX → R2 → updates row + emits
/// `cover_letter_rendered`). Idempotent on (cover_letter_id, kind).
pub async fn enqueue_render(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let exists: Option<(Uuid,)> =
        sqlx::query_as("select id from cover_letters where id = $1 and user_id = $2")
            .bind(id)
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    let payload_match = json!({ "cover_letter_id": id });

    if let Some(existing) =
        jobs::find_active(&state.db, user.id, KIND_COVER_LETTER_RENDER, &payload_match)
            .await
            .map_err(AppError::Db)?
    {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "job_id": existing.id, "status": existing.status, "deduped": true })),
        ));
    }

    let job = jobs::enqueue(
        &state.db,
        user.id,
        KIND_COVER_LETTER_RENDER,
        payload_match,
        3,
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "job_id": job.id, "status": job.status, "deduped": false })),
    ))
}
