//! Upwork proposals (Track 20).
//!
//! Upwork postings have no company, so there's no company-research step — the
//! desktop instead surfaces related open-source projects (proof/plan material)
//! and generates an AIDA proposal. This module just stores the resulting
//! proposal against an application and serves the latest one back, mirroring the
//! cover_letters / company_research append style (newest row = current).

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
pub struct Proposal {
    pub id: Uuid,
    pub application_id: Uuid,
    /// AIDA opener variants — the decisive Upwork first line(s).
    pub openers: serde_json::Value,
    /// Index into `openers` the user picked.
    pub selected_opener: i32,
    /// Body of the proposal (Interest → Desire → Action), opener excluded.
    pub body: String,
    pub strategy: String,
    pub proposal_length: String,
    pub angle: Option<String>,
    /// Related open-source repos surfaced as proof/plan material.
    pub projects: serde_json::Value,
    /// Answers to the Upwork screening/follow-up questions (Q&A array).
    pub screening: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProposalRequest {
    pub openers: Option<serde_json::Value>,
    pub selected_opener: Option<i32>,
    /// Body of the proposal — required, non-empty.
    pub body: String,
    pub strategy: Option<String>,
    pub proposal_length: Option<String>,
    pub angle: Option<String>,
    pub projects: Option<serde_json::Value>,
    pub screening: Option<serde_json::Value>,
}

/// POST /v1/applications/:id/proposals
///
/// Persist a freshly generated proposal. Returns the stored row.
pub async fn create(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
    Json(req): Json<CreateProposalRequest>,
) -> Result<Json<Proposal>, AppError> {
    if req.body.trim().is_empty() {
        return Err(AppError::BadRequest("body must be non-empty".to_string()));
    }
    let openers = req
        .openers
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    let projects = req
        .projects
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    let screening = req
        .screening
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    let selected_opener = req.selected_opener.unwrap_or(0);
    let strategy = req.strategy.unwrap_or_else(|| "aida".to_string());
    let proposal_length = req.proposal_length.unwrap_or_else(|| "short".to_string());

    let row = sqlx::query_as::<_, Proposal>(
        r#"
        insert into proposals
            (application_id, openers, selected_opener, body, strategy, proposal_length, angle, projects, screening)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id, application_id, openers, selected_opener, body, strategy,
                  proposal_length, angle, projects, screening, created_at
        "#,
    )
    .bind(application_id)
    .bind(&openers)
    .bind(selected_opener)
    .bind(&req.body)
    .bind(&strategy)
    .bind(&proposal_length)
    .bind(&req.angle)
    .bind(&projects)
    .bind(&screening)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

/// GET /v1/applications/:id/proposals — latest one, or 404.
pub async fn get_latest(
    State(state): State<AppState>,
    Path(application_id): Path<Uuid>,
) -> Result<Json<Proposal>, AppError> {
    let row = sqlx::query_as::<_, Proposal>(
        r#"
        select id, application_id, openers, selected_opener, body, strategy,
               proposal_length, angle, projects, screening, created_at
        from proposals
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
