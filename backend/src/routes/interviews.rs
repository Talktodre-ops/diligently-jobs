use crate::error::AppError;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct Interview {
    pub id: Uuid,
    pub application_id: Option<Uuid>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    /// JSON array of {ts, kind: "interim"|"final", text} segments.
    pub transcript: serde_json::Value,
    /// JSON array of AI completions served during the session.
    pub ai_messages: serde_json::Value,
    pub r2_audio_key: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct StartInterviewRequest {
    pub application_id: Option<Uuid>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EndInterviewRequest {
    /// Final transcript (replaces server state — desktop client owns assembly).
    pub transcript: Option<serde_json::Value>,
    pub ai_messages: Option<serde_json::Value>,
    pub r2_audio_key: Option<String>,
    pub notes: Option<String>,
    /// If omitted, server uses `now()` as the end time.
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct ListInterviewsQuery {
    pub application_id: Option<Uuid>,
    pub limit: Option<i64>,
}

/// POST /v1/interviews
///
/// Start a new interview session. Returns the row with `started_at = now()`
/// and `ended_at = null`. Desktop client should PATCH when the session ends.
pub async fn start(
    State(state): State<AppState>,
    Json(req): Json<StartInterviewRequest>,
) -> Result<Json<Interview>, AppError> {
    let iv = sqlx::query_as::<_, Interview>(
        r#"
        insert into interviews (application_id, notes)
        values ($1, $2)
        returning id, application_id, started_at, ended_at, transcript, ai_messages,
                  r2_audio_key, notes, created_at
        "#,
    )
    .bind(req.application_id)
    .bind(&req.notes)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(iv))
}

/// PATCH /v1/interviews/:id
///
/// End or update an in-flight session. All fields are optional; supply only
/// the ones that changed. `ended_at` defaults to `now()` if any other field
/// is being set and `ended_at` isn't yet recorded.
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<EndInterviewRequest>,
) -> Result<Json<Interview>, AppError> {
    // If the caller didn't explicitly set ended_at but is patching anything,
    // assume they're ending it.
    let ended_at: Option<DateTime<Utc>> = req.ended_at.or_else(|| Some(Utc::now()));

    let iv = sqlx::query_as::<_, Interview>(
        r#"
        update interviews set
            transcript    = coalesce($2, transcript),
            ai_messages   = coalesce($3, ai_messages),
            r2_audio_key  = coalesce($4, r2_audio_key),
            notes         = coalesce($5, notes),
            ended_at      = coalesce(ended_at, $6)
        where id = $1
        returning id, application_id, started_at, ended_at, transcript, ai_messages,
                  r2_audio_key, notes, created_at
        "#,
    )
    .bind(id)
    .bind(&req.transcript)
    .bind(&req.ai_messages)
    .bind(&req.r2_audio_key)
    .bind(&req.notes)
    .bind(ended_at)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(iv))
}

/// GET /v1/interviews
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListInterviewsQuery>,
) -> Result<Json<Vec<Interview>>, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<_, Interview>(
        r#"
        select id, application_id, started_at, ended_at, transcript, ai_messages,
               r2_audio_key, notes, created_at
        from interviews
        where ($1::uuid is null or application_id = $1)
        order by started_at desc
        limit $2
        "#,
    )
    .bind(q.application_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// GET /v1/interviews/:id
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Interview>, AppError> {
    let iv = sqlx::query_as::<_, Interview>(
        r#"
        select id, application_id, started_at, ended_at, transcript, ai_messages,
               r2_audio_key, notes, created_at
        from interviews
        where id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(iv))
}
