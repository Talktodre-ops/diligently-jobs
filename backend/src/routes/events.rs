use crate::error::AppError;
use crate::AppState;
use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// One row of the append-only events spine. Every meaningful action in the
/// desktop app writes one of these.
#[derive(Debug, Serialize, FromRow)]
pub struct Event {
    pub id: Uuid,
    pub kind: String,
    pub payload: serde_json::Value,
    pub application_id: Option<Uuid>,
    pub device_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct AppendEventRequest {
    pub kind: String,
    /// Arbitrary JSON payload. Convention: keep keys snake_case, no PII unless
    /// you mean to log it forever.
    #[serde(default)]
    pub payload: serde_json::Value,
    pub application_id: Option<Uuid>,
    pub device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListEventsQuery {
    /// Filter to events with this kind.
    pub kind: Option<String>,
    /// Filter to events for this application.
    pub application_id: Option<Uuid>,
    /// Only events created strictly after this timestamp (for polling cursors).
    pub since: Option<DateTime<Utc>>,
    /// Max rows to return. Default 100, cap 500.
    pub limit: Option<i64>,
}

/// POST /v1/events
///
/// Append one event. Returns the persisted row so the client can immediately
/// know its assigned `id` and `created_at`.
pub async fn append(
    State(state): State<AppState>,
    Json(req): Json<AppendEventRequest>,
) -> Result<Json<Event>, AppError> {
    if req.kind.trim().is_empty() {
        return Err(AppError::BadRequest("kind must be non-empty".to_string()));
    }
    let event = sqlx::query_as::<_, Event>(
        r#"
        insert into events (kind, payload, application_id, device_id)
        values ($1, $2, $3, $4)
        returning id, kind, payload, application_id, device_id, created_at
        "#,
    )
    .bind(&req.kind)
    .bind(&req.payload)
    .bind(req.application_id)
    .bind(&req.device_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(event))
}

/// GET /v1/events
///
/// List recent events, newest first. Pagination is timestamp-cursor: pass
/// `since=<last seen created_at>` on the next page to skip already-seen rows.
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListEventsQuery>,
) -> Result<Json<Vec<Event>>, AppError> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);

    let events = sqlx::query_as::<_, Event>(
        r#"
        select id, kind, payload, application_id, device_id, created_at
        from events
        where
            ($1::text is null or kind = $1)
            and ($2::uuid is null or application_id = $2)
            and ($3::timestamptz is null or created_at > $3)
        order by created_at desc
        limit $4
        "#,
    )
    .bind(q.kind.as_deref())
    .bind(q.application_id)
    .bind(q.since)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(events))
}
