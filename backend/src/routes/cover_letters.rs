//! Cover letters (Phase 3, M2).
//!
//! Generated + edited on the desktop (AIDA structure), stored here as an
//! immutable row (newest = current). Rendering reuses the async job worker +
//! Tectonic/docx pipeline, exactly like cv_versions.

use crate::error::AppError;
use crate::jobs::{self, handlers::KIND_COVER_LETTER_RENDER};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
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
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCoverLetterRequest {
    /// Plain-text body (paragraphs joined) — quick display/search.
    pub body: String,
    /// Structured letter for rendering (CoverLetterDoc shape).
    pub doc: serde_json::Value,
    /// Optional cited research sources used.
    pub sources: Option<serde_json::Value>,
}

/// POST /v1/applications/:id/cover-letters
pub async fn create(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
    Json(req): Json<CreateCoverLetterRequest>,
) -> Result<Json<CoverLetter>, AppError> {
    if req.body.trim().is_empty() {
        return Err(AppError::BadRequest("body must be non-empty".to_string()));
    }
    let sources = req
        .sources
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));

    let row = sqlx::query_as::<_, CoverLetter>(
        r#"
        insert into cover_letters (application_id, body, sources, doc)
        values ($1, $2, $3, $4)
        returning id, application_id, body, sources, doc, r2_pdf_key, r2_docx_key, generated_at
        "#,
    )
    .bind(application_id)
    .bind(&req.body)
    .bind(&sources)
    .bind(&req.doc)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

/// GET /v1/applications/:id/cover-letters — latest one, or 404.
pub async fn get_latest(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
) -> Result<Json<CoverLetter>, AppError> {
    let row = sqlx::query_as::<_, CoverLetter>(
        r#"
        select id, application_id, body, sources, doc, r2_pdf_key, r2_docx_key, generated_at
        from cover_letters
        where application_id = $1
        order by generated_at desc
        limit 1
        "#,
    )
    .bind(application_id)
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
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let exists: Option<(Uuid,)> =
        sqlx::query_as("select id from cover_letters where id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    let payload_match = json!({ "cover_letter_id": id });

    if let Some(existing) =
        jobs::find_active(&state.db, KIND_COVER_LETTER_RENDER, &payload_match)
            .await
            .map_err(AppError::Db)?
    {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "job_id": existing.id, "status": existing.status, "deduped": true })),
        ));
    }

    let job = jobs::enqueue(&state.db, KIND_COVER_LETTER_RENDER, payload_match, 3).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "job_id": job.id, "status": job.status, "deduped": false })),
    ))
}
