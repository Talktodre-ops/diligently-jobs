use crate::error::AppError;
use crate::jobs::{self, handlers::KIND_CV_RENDER};
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
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
pub struct CvVersion {
    pub id: Uuid,
    /// NULL = base CV (not tied to any specific application).
    pub application_id: Option<Uuid>,
    pub sections: serde_json::Value,
    pub r2_blob_key: Option<String>,
    pub r2_pdf_key: Option<String>,
    pub r2_docx_key: Option<String>,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCvVersionRequest {
    /// Omit for base CV; supply to tie to a specific application's variant.
    pub application_id: Option<Uuid>,
    /// Structured CV — array of {section, bullets[]} objects per the desktop type.
    pub sections: serde_json::Value,
    /// Optional R2 key if the user uploaded a source PDF/DOCX (use the
    /// /v1/blobs/presign-upload flow first to get a key).
    pub r2_blob_key: Option<String>,
    /// Free-form label: "base", "tailored-acme-fe", "v2-after-tweaks", etc.
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListCvVersionsQuery {
    /// Filter to a specific application's variants. Omit to include base CVs
    /// (application_id IS NULL).
    pub application_id: Option<Uuid>,
    /// If true and no application_id filter, returns only base CVs.
    pub base_only: Option<bool>,
    pub limit: Option<i64>,
}

/// POST /v1/cv-versions
pub async fn create(
    State(state): State<AppState>,
    Json(req): Json<CreateCvVersionRequest>,
) -> Result<Json<CvVersion>, AppError> {
    let cv = sqlx::query_as::<_, CvVersion>(
        r#"
        insert into cv_versions (application_id, sections, r2_blob_key, label)
        values ($1, $2, $3, $4)
        returning id, application_id, sections, r2_blob_key, r2_pdf_key, r2_docx_key, label, created_at
        "#,
    )
    .bind(req.application_id)
    .bind(&req.sections)
    .bind(&req.r2_blob_key)
    .bind(&req.label)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(cv))
}

/// GET /v1/cv-versions
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListCvVersionsQuery>,
) -> Result<Json<Vec<CvVersion>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);

    let rows = if let Some(app_id) = q.application_id {
        sqlx::query_as::<_, CvVersion>(
            r#"
            select id, application_id, sections, r2_blob_key, r2_pdf_key, r2_docx_key, label, created_at
            from cv_versions
            where application_id = $1
            order by created_at desc
            limit $2
            "#,
        )
        .bind(app_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else if q.base_only.unwrap_or(false) {
        sqlx::query_as::<_, CvVersion>(
            r#"
            select id, application_id, sections, r2_blob_key, r2_pdf_key, r2_docx_key, label, created_at
            from cv_versions
            where application_id is null
            order by created_at desc
            limit $1
            "#,
        )
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, CvVersion>(
            r#"
            select id, application_id, sections, r2_blob_key, r2_pdf_key, r2_docx_key, label, created_at
            from cv_versions
            order by created_at desc
            limit $1
            "#,
        )
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(rows))
}

/// GET /v1/cv-versions/:id
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<CvVersion>, AppError> {
    let cv = sqlx::query_as::<_, CvVersion>(
        r#"
        select id, application_id, sections, r2_blob_key, r2_pdf_key, r2_docx_key, label, created_at
        from cv_versions
        where id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(cv))
}

/// POST /v1/cv-versions/:id/render
///
/// Enqueues an async render job (PDF + DOCX → R2 → updates row + emits
/// `cv_rendered` event). Returns 202 Accepted with the job id; client polls
/// `GET /v1/jobs/:id` until `status: "done"`.
///
/// Idempotent on (cv_version_id, kind): if a render job for this CV is
/// already queued or running, returns that one instead of enqueueing a
/// duplicate.
pub async fn enqueue_render(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    // 404 fast if the CV doesn't exist — saves a job that would just fail.
    let exists: Option<(Uuid,)> =
        sqlx::query_as("select id from cv_versions where id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    let payload_match = json!({ "cv_version_id": id });

    if let Some(existing) = jobs::find_active(&state.db, KIND_CV_RENDER, &payload_match)
        .await
        .map_err(AppError::Db)?
    {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "job_id": existing.id, "status": existing.status, "deduped": true })),
        ));
    }

    let job = jobs::enqueue(&state.db, KIND_CV_RENDER, payload_match, 3).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "job_id": job.id, "status": job.status, "deduped": false })),
    ))
}
