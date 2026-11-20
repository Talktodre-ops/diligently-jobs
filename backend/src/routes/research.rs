//! Company research (the Research screen): overview, talking points and the
//! sources they cite.

use axum::extract::State;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{CurrentUser, VerifiedUser};
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::prompts::research;
use crate::AppState;

#[derive(Debug, Serialize, FromRow)]
pub struct CompanyResearch {
    pub id: Uuid,
    pub application_id: Uuid,
    pub brief: serde_json::Value,
    pub sources: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

async fn latest(
    state: &AppState,
    uid: Uuid,
    app_id: Uuid,
) -> Result<Option<CompanyResearch>, AppError> {
    Ok(sqlx::query_as::<_, CompanyResearch>(
        r#"
        select id, application_id, brief, sources, created_at from company_research
        where application_id = $1 and user_id = $2 order by created_at desc limit 1
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?)
}

/// GET /v1/applications/{id}/research
pub async fn get_latest(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<CompanyResearch>, AppError> {
    crate::routes::ensure_application(&state.db, user.id, app_id).await?;
    latest(&state, user.id, app_id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}

/// POST /v1/applications/{id}/research/refresh: search again and rebuild the
/// brief. Runs inline; it takes a few seconds.
pub async fn refresh(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<CompanyResearch>, AppError> {
    let (company, role): (Option<String>, Option<String>) =
        sqlx::query_as("select company, role from applications where id = $1 and user_id = $2")
            .bind(app_id)
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?
            .ok_or(AppError::NotFound)?;
    let company = company
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| AppError::unprocessable("company_unknown", "Add the company name first."))?;
    let hits = state
        .web
        .search(&format!("{company} company news products"), 6)
        .await?;
    if hits.is_empty() {
        return Err(AppError::unprocessable(
            "nothing_found",
            "We could not find anything about this company.",
        ));
    }
    let res = crate::usage::call(
        &state,
        user.id,
        Some(app_id),
        research::request(&company, role.as_deref().unwrap_or(""), &hits),
    )
    .await?;
    let brief = research::parse(res.value, hits.len()).map_err(|e| {
        tracing::warn!(error = %e, "research rejected");
        AppError::unavailable("ai_failed", "Research did not come out right. Try again.")
    })?;
    sqlx::query("insert into company_research (application_id, user_id, brief, sources) values ($1, $2, $3, $4)")
        .bind(app_id)
        .bind(user.id)
        .bind(json!(brief))
        .bind(serde_json::to_value(&hits).map_err(anyhow::Error::from)?)
        .execute(&state.db)
        .await?;
    latest(&state, user.id, app_id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}
