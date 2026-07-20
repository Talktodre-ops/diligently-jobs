use crate::error::AppError;
use crate::routes::events::Event;
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
pub struct Application {
    pub id: Uuid,
    pub company: Option<String>,
    pub role: Option<String>,
    pub jd_raw: String,
    pub requirements: Option<serde_json::Value>,
    pub status: String,
    pub submitted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub latest_cv_version_id: Option<Uuid>,
    pub latest_cv_pdf_key: Option<String>,
    pub latest_cv_docx_key: Option<String>,
    pub latest_cv_rendered_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateApplicationRequest {
    pub jd_raw: String,
    pub company: Option<String>,
    pub role: Option<String>,
    pub requirements: Option<serde_json::Value>,
    /// Defaults to "draft" if omitted.
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListApplicationsQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PatchApplicationRequest {
    pub company: Option<String>,
    pub role: Option<String>,
    pub requirements: Option<serde_json::Value>,
    pub status: Option<String>,
    pub submitted_at: Option<DateTime<Utc>>,
}

/// POST /v1/applications
pub async fn create(
    State(state): State<AppState>,
    Json(req): Json<CreateApplicationRequest>,
) -> Result<Json<Application>, AppError> {
    if req.jd_raw.trim().is_empty() {
        return Err(AppError::BadRequest("jd_raw must be non-empty".to_string()));
    }
    let app = sqlx::query_as::<_, Application>(
        r#"
        insert into applications (jd_raw, company, role, requirements, status)
        values ($1, $2, $3, $4, coalesce($5, 'draft'))
        returning id, company, role, jd_raw, requirements, status,
                  submitted_at, created_at, updated_at,
                  latest_cv_version_id, latest_cv_pdf_key,
                  latest_cv_docx_key, latest_cv_rendered_at
        "#,
    )
    .bind(&req.jd_raw)
    .bind(&req.company)
    .bind(&req.role)
    .bind(&req.requirements)
    .bind(&req.status)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(app))
}

/// GET /v1/applications
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListApplicationsQuery>,
) -> Result<Json<Vec<Application>>, AppError> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let apps = sqlx::query_as::<_, Application>(
        r#"
        select id, company, role, jd_raw, requirements, status,
               submitted_at, created_at, updated_at,
               latest_cv_version_id, latest_cv_pdf_key,
               latest_cv_docx_key, latest_cv_rendered_at
        from applications
        where ($1::text is null or status = $1)
        order by updated_at desc
        limit $2
        "#,
    )
    .bind(q.status.as_deref())
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(apps))
}

/// GET /v1/applications/:id
pub async fn get_one(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Application>, AppError> {
    let app = sqlx::query_as::<_, Application>(
        r#"
        select id, company, role, jd_raw, requirements, status,
               submitted_at, created_at, updated_at,
               latest_cv_version_id, latest_cv_pdf_key,
               latest_cv_docx_key, latest_cv_rendered_at
        from applications
        where id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(app))
}

/// PATCH /v1/applications/:id
///
/// Partial update. Any field that's `None` in the request stays at its
/// existing value via the `coalesce($n, column)` pattern.
pub async fn patch(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<PatchApplicationRequest>,
) -> Result<Json<Application>, AppError> {
    let app = sqlx::query_as::<_, Application>(
        r#"
        update applications set
            company       = coalesce($2, company),
            role          = coalesce($3, role),
            requirements  = coalesce($4, requirements),
            status        = coalesce($5, status),
            submitted_at  = coalesce($6, submitted_at)
        where id = $1
        returning id, company, role, jd_raw, requirements, status,
                  submitted_at, created_at, updated_at,
                  latest_cv_version_id, latest_cv_pdf_key,
                  latest_cv_docx_key, latest_cv_rendered_at
        "#,
    )
    .bind(id)
    .bind(&req.company)
    .bind(&req.role)
    .bind(&req.requirements)
    .bind(&req.status)
    .bind(req.submitted_at)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(app))
}

/// GET /v1/applications/:id/timeline
///
/// Returns all events for this application, newest first. Useful for the
/// "History" UI in the desktop app — one application's full audit trail.
pub async fn timeline(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<Event>>, AppError> {
    let events = sqlx::query_as::<_, Event>(
        r#"
        select id, kind, payload, application_id, device_id, created_at
        from events
        where application_id = $1
        order by created_at desc
        limit 1000
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(events))
}
