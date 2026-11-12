//! Diligently API library crate. `main.rs` is a thin binary over this so
//! integration tests can build the real router against a test database.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod jobs;
pub mod llm;
pub mod r2;
pub mod render;
pub mod routes;

use axum::{
    http::{header, HeaderValue, Method},
    middleware,
    routing::{get, post},
    Router,
};
use sqlx::PgPool;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::r2::R2;

/// Shared application state. Cheap to clone (Arcs underneath) so we hand it to
/// every route via `State(AppState)`.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub r2: R2,
}

pub fn build_router(state: AppState) -> Router {
    // Public routes — no bearer required.
    let public = Router::new().route("/health", get(routes::health::health));

    // Protected routes — every request must carry a valid Bearer token.
    // `route_layer` only applies to routes added BEFORE the call, so routes go first.
    let protected = Router::new()
        // Bearer check ping
        .route("/v1/me", get(routes::me::me))
        // Events spine
        .route(
            "/v1/events",
            post(routes::events::append).get(routes::events::list),
        )
        // Applications — central projection
        .route(
            "/v1/applications",
            post(routes::applications::create).get(routes::applications::list),
        )
        .route(
            "/v1/applications/{id}",
            get(routes::applications::get_one).patch(routes::applications::patch),
        )
        .route(
            "/v1/applications/{id}/timeline",
            get(routes::applications::timeline),
        )
        // Company research — web-sourced briefs (synthesized on the desktop)
        .route(
            "/v1/applications/{id}/research",
            post(routes::research::create).get(routes::research::get_latest),
        )
        // Cover letters — AIDA letters; render reuses the job worker
        .route(
            "/v1/applications/{id}/cover-letters",
            post(routes::cover_letters::create).get(routes::cover_letters::get_latest),
        )
        .route(
            "/v1/cover-letters/{id}/render",
            post(routes::cover_letters::enqueue_render),
        )
        // Upwork proposals — AIDA proposals (no render; copy-paste artifact)
        .route(
            "/v1/applications/{id}/proposals",
            post(routes::proposals::create).get(routes::proposals::get_latest),
        )
        // ATS scores — async LLM scoring of a CV vs the JD
        .route(
            "/v1/applications/{id}/ats-score",
            post(routes::ats_scores::enqueue).get(routes::ats_scores::get_latest),
        )
        // CV versions — immutable snapshots
        .route(
            "/v1/cv-versions",
            post(routes::cv_versions::create).get(routes::cv_versions::list),
        )
        .route(
            "/v1/cv-versions/{id}",
            get(routes::cv_versions::get_one),
        )
        .route(
            "/v1/cv-versions/{id}/render",
            post(routes::cv_versions::enqueue_render),
        )
        // Async job status (used by the desktop to poll render progress)
        .route("/v1/jobs/{id}", get(routes::jobs::get_one))
        // Interviews — capture sessions
        .route(
            "/v1/interviews",
            post(routes::interviews::start).get(routes::interviews::list),
        )
        .route(
            "/v1/interviews/{id}",
            get(routes::interviews::get_one).patch(routes::interviews::patch),
        )
        // R2 blob presigning
        .route("/v1/blobs/presign-upload", post(routes::blobs::presign_upload))
        .route(
            "/v1/blobs/presign-download",
            post(routes::blobs::presign_download),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_bearer,
        ));

    Router::new()
        .merge(public)
        .merge(protected)
        .with_state(state)
        .layer(cors_layer())
        .layer(TraceLayer::new_for_http())
}

/// CORS for the desktop in `npm run dev` mode (Vite at localhost:1420) and
/// for packaged Tauri webview origins (tauri://localhost on macOS/Linux,
/// https://tauri.localhost on Windows).
///
/// We don't allow `Any` because that would forbid the `Authorization` header
/// echo browsers need for the bearer flow. Listing concrete origins keeps the
/// preflight clean. Override via the `CORS_ALLOWED_ORIGINS` env var
/// (comma-separated) if you add a new origin (e.g. a future web dashboard).
fn cors_layer() -> CorsLayer {
    let defaults: Vec<HeaderValue> = [
        "http://localhost:1420",
        "http://localhost:1421",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]
    .into_iter()
    .filter_map(|s| s.parse().ok())
    .collect();

    let origins: Vec<HeaderValue> = match std::env::var("CORS_ALLOWED_ORIGINS") {
        Ok(env) if !env.trim().is_empty() => env
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect(),
        _ => defaults,
    };

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600))
}
