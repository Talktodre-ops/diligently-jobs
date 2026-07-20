//! Read-only job status endpoint. The desktop polls this after enqueueing.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;
use uuid::Uuid;

use crate::error::AppError;
use crate::jobs::{self, Job};
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct JobView {
    pub id: Uuid,
    pub kind: String,
    pub status: String,
    pub result: Option<serde_json::Value>,
    pub attempts: i32,
    pub max_attempts: i32,
    pub last_error: Option<String>,
}

impl From<Job> for JobView {
    fn from(j: Job) -> Self {
        Self {
            id: j.id,
            kind: j.kind,
            status: j.status,
            result: j.result,
            attempts: j.attempts,
            max_attempts: j.max_attempts,
            last_error: j.last_error,
        }
    }
}

/// GET /v1/jobs/:id
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<JobView>, AppError> {
    let job = jobs::get_by_id(&state.db, id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(job.into()))
}
