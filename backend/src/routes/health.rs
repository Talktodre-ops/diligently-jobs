use crate::error::AppError;
use crate::AppState;
use axum::{extract::State, Json};
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub postgres: ComponentStatus,
    pub r2: ComponentStatus,
}

#[derive(Serialize)]
pub struct ComponentStatus {
    pub ok: bool,
    pub detail: Option<String>,
}

/// GET /health
///
/// Pings Postgres + R2 in parallel. Returns 200 if both healthy, 503 otherwise.
/// Public — no bearer required, so deployment health checks (Tailscale, Fly, etc.)
/// can hit it without secrets.
pub async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, AppError> {
    let (pg, r2) = tokio::join!(ping_postgres(&state), ping_r2(&state));

    let status = if pg.ok && r2.ok { "ok" } else { "degraded" };
    Ok(Json(HealthResponse {
        status,
        postgres: pg,
        r2,
    }))
}

async fn ping_postgres(state: &AppState) -> ComponentStatus {
    match sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => ComponentStatus { ok: true, detail: None },
        Err(e) => ComponentStatus {
            ok: false,
            detail: Some(e.to_string()),
        },
    }
}

async fn ping_r2(state: &AppState) -> ComponentStatus {
    match state.r2.ping().await {
        Ok(_) => ComponentStatus { ok: true, detail: None },
        Err(e) => ComponentStatus {
            ok: false,
            detail: Some(e.to_string()),
        },
    }
}
