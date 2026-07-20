//! Company research persistence (Phase 3, M1).
//!
//! The Brave search + AI synthesis happen on the desktop; this module just
//! stores the resulting brief against an application and serves the latest one
//! back. Each generation is an immutable row (newest = current), mirroring the
//! cv_versions / events append style.

use crate::error::AppError;
use crate::AppState;
use axum::{
    extract::{Path, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct CompanyResearch {
    pub id: Uuid,
    pub application_id: Uuid,
    pub brief: serde_json::Value,
    pub sources: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateResearchRequest {
    pub brief: serde_json::Value,
    /// List of source objects/URLs the brief was built from. Optional.
    pub sources: Option<serde_json::Value>,
}

/// POST /v1/applications/:id/research
///
/// Persist a freshly synthesized brief. Returns the stored row.
pub async fn create(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
    Json(req): Json<CreateResearchRequest>,
) -> Result<Json<CompanyResearch>, AppError> {
    if req.brief.is_null() {
        return Err(AppError::BadRequest("brief must not be null".to_string()));
    }
    let sources = req
        .sources
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));

    let row = sqlx::query_as::<_, CompanyResearch>(
        r#"
        insert into company_research (application_id, brief, sources)
        values ($1, $2, $3)
        returning id, application_id, brief, sources, created_at
        "#,
    )
    .bind(application_id)
    .bind(&req.brief)
    .bind(&sources)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

/// GET /v1/applications/:id/research
///
/// Returns the most recent brief for the application, or 404 when none exists
/// yet (the desktop treats that as "no research run yet").
pub async fn get_latest(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
) -> Result<Json<CompanyResearch>, AppError> {
    let row = sqlx::query_as::<_, CompanyResearch>(
        r#"
        select id, application_id, brief, sources, created_at
        from company_research
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
