//! ATS scores (the "disparity on the ATS scale").
//!
//! Scoring is an async LLM job (jobs::handlers::ats_score). This module
//! enqueues it and serves the latest stored score back, mirroring the
//! cv-render / cover-letter enqueue pattern.

use crate::error::AppError;
use crate::jobs::{self, handlers::KIND_ATS_SCORE};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct AtsScore {
    pub id: Uuid,
    pub application_id: Uuid,
    pub cv_version_id: Option<Uuid>,
    pub score: i32,
    pub base_score: Option<i32>,
    pub breakdown: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

/// POST /v1/applications/:id/ats-score
///
/// Enqueues an async ATS scoring job and returns 202 + the job id. Idempotent
/// on (application_id, kind): an in-flight job is reused.
pub async fn enqueue(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let exists: Option<(Uuid,)> =
        sqlx::query_as("select id from applications where id = $1")
            .bind(application_id)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    let payload_match = json!({ "application_id": application_id });

    if let Some(existing) = jobs::find_active(&state.db, KIND_ATS_SCORE, &payload_match)
        .await
        .map_err(AppError::Db)?
    {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "job_id": existing.id, "status": existing.status, "deduped": true })),
        ));
    }

    let job = jobs::enqueue(&state.db, KIND_ATS_SCORE, payload_match, 2).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "job_id": job.id, "status": job.status, "deduped": false })),
    ))
}

/// GET /v1/applications/:id/ats-score — the latest score, or 404 when none yet.
pub async fn get_latest(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
) -> Result<Json<AtsScore>, AppError> {
    let row = sqlx::query_as::<_, AtsScore>(
        r#"
        select id, application_id, cv_version_id, score, base_score, breakdown, created_at
        from ats_scores
        where application_id = $1
        order by created_at desc
        limit 1
        "#,
    )
    .bind(application_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(row))
}
