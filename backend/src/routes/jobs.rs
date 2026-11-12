//! Read-only job status endpoint, polled by the Running screen.

use crate::extract::{Json, Path};
use axum::extract::State;
use serde::Serialize;
use uuid::Uuid;

use crate::auth::CurrentUser;
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
    /// Steps of a multi-step job, each with a status.
    pub progress: Option<serde_json::Value>,
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
            // last_error is internal detail (provider messages, SQL); the
            // client gets status and per-step progress instead.
            progress: j.progress,
        }
    }
}

/// GET /v1/jobs/:id
pub async fn get_one(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> Result<Json<JobView>, AppError> {
    let job = jobs::get_by_id(&state.db, user.id, id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(job.into()))
}
