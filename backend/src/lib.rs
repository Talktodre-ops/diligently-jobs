//! Diligently API library crate. `main.rs` is a thin binary over this so
//! integration tests can build the real router against a test database.

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod extract;
pub mod jobs;
pub mod legacy;
pub mod llm;
pub mod mail;
pub mod r2;
pub mod rate_limit;
pub mod render;
pub mod routes;
pub mod validate;

use axum::{
    http::{header, HeaderValue, Method},
    middleware,
    routing::{delete, get, post},
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
    pub mailer: Arc<dyn mail::Mailer>,
    pub limiter: Arc<rate_limit::RateLimiter>,
}

pub fn build_router(state: AppState) -> Router {
    // Public routes: health and the account endpoints, which authenticate
    // through their own extractors (CurrentUser) where needed.
    use auth::routes as a;
    let public = Router::new()
        .route("/health", get(routes::health::health))
        .route("/v1/auth/signup", post(a::signup))
        .route("/v1/auth/signin", post(a::signin))
        .route("/v1/auth/signout", post(a::signout))
        .route("/v1/auth/me", get(a::me))
        .route("/v1/auth/verify", post(a::verify))
        .route("/v1/auth/resend-verification", post(a::resend_verification))
        .route("/v1/auth/forgot-password", post(a::forgot_password))
        .route("/v1/auth/reset-password", post(a::reset_password))
        .route("/v1/auth/change-password", post(a::change_password))
        .route("/v1/auth/change-email", post(a::change_email))
        .route("/v1/auth/confirm-email", post(a::confirm_email))
        .route("/v1/auth/sessions", get(a::list_sessions))
        .route(
            "/v1/auth/sessions/revoke-others",
            post(a::revoke_other_sessions),
        )
        .route("/v1/auth/sessions/{id}", delete(a::revoke_session));

    // Resource routes. Every handler takes `CurrentUser`, which rejects a
    // signed-out request with 401, and scopes every query to that user.
    use routes::{
        applications, ats_scores, blobs, cover_letters, cv_versions, events, interviews,
        jobs as job_routes, profile, research,
    };
    let resources = Router::new()
        .route("/v1/events", post(events::append).get(events::list))
        .route(
            "/v1/applications",
            post(applications::create).get(applications::list),
        )
        .route(
            "/v1/applications/{id}",
            get(applications::get_one).patch(applications::patch),
        )
        .route(
            "/v1/applications/{id}/timeline",
            get(applications::timeline),
        )
        .route(
            "/v1/applications/{id}/research",
            post(research::create).get(research::get_latest),
        )
        .route(
            "/v1/applications/{id}/cover-letters",
            post(cover_letters::create).get(cover_letters::get_latest),
        )
        .route(
            "/v1/cover-letters/{id}/render",
            post(cover_letters::enqueue_render),
        )
        .route(
            "/v1/applications/{id}/ats-score",
            post(ats_scores::enqueue).get(ats_scores::get_latest),
        )
        .route(
            "/v1/cv-versions",
            post(cv_versions::create).get(cv_versions::list),
        )
        .route("/v1/cv-versions/{id}", get(cv_versions::get_one))
        .route(
            "/v1/cv-versions/{id}/render",
            post(cv_versions::enqueue_render),
        )
        .route("/v1/jobs/{id}", get(job_routes::get_one))
        .route(
            "/v1/interviews",
            post(interviews::start).get(interviews::list),
        )
        .route(
            "/v1/interviews/{id}",
            get(interviews::get_one).patch(interviews::patch),
        )
        .route("/v1/blobs/presign-download", post(blobs::presign_download))
        .route("/v1/profile", get(profile::get).patch(profile::patch));

    Router::new()
        .merge(public)
        .merge(resources)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::csrf::require_allowed_origin,
        ))
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
