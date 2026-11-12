//! Diligently API library crate. `main.rs` is a thin binary over this so
//! integration tests can build the real router against a test database.

pub mod ai;
pub mod auth;
pub mod config;
pub mod db;
pub mod docx_text;
pub mod error;
pub mod extract;
pub mod followups;
pub mod jobs;
pub mod legacy;
pub mod mail;
pub mod pipeline;
pub mod prompts;
pub mod r2;
pub mod rate_limit;
pub mod render;
pub mod routes;
pub mod usage;
pub mod validate;
pub mod web;

use axum::{
    http::{header, HeaderValue, Method},
    middleware,
    routing::{delete, get, patch, post},
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
    pub ai: Arc<dyn ai::Llm>,
    pub web: Arc<dyn web::WebSearch>,
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
        account, applications, ats_scores, blobs, cover_letters, cv, cv_versions, events, files,
        gaps, home, interviews, jobs as job_routes, profile, research, review, tracking, uploads,
        workspace,
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
        .route("/v1/applications/{id}/research", get(research::get_latest))
        .route(
            "/v1/applications/{id}/research/refresh",
            post(research::refresh),
        )
        .route(
            "/v1/applications/{id}/cover-letters",
            get(cover_letters::get_latest),
        )
        .route(
            "/v1/applications/{id}/cover-letters/regenerate",
            post(cover_letters::regenerate),
        )
        .route("/v1/cover-letters/{id}", patch(cover_letters::edit))
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
        .route("/v1/profile", get(profile::get).patch(profile::patch))
        .route("/v1/cv/master", get(cv::get_master).put(cv::put_master))
        .route("/v1/usage", get(usage::get))
        .route(
            "/v1/cv/upload",
            post(uploads::upload).layer(axum::extract::DefaultBodyLimit::max(
                uploads::MAX_UPLOAD_BYTES + 64 * 1024,
            )),
        )
        .route("/v1/cv/uploads/{id}", get(uploads::get_upload))
        .route("/v1/applications/start", post(workspace::start))
        .route("/v1/applications/{id}/brief", get(review::brief))
        .route("/v1/applications/{id}/rewrites", get(review::list_rewrites))
        .route(
            "/v1/applications/{id}/summary",
            patch(review::decide_summary),
        )
        .route("/v1/applications/{id}/cv", get(review::tailored_cv))
        .route("/v1/applications/{id}/rescore", post(review::rescore))
        .route("/v1/rewrites/{id}", patch(review::decide_rewrite))
        .route("/v1/applications/{id}/gaps", get(gaps::list))
        .route("/v1/gaps/{id}/answer", post(gaps::answer))
        .route("/v1/gaps/{id}", patch(gaps::decide))
        .route("/v1/applications/{id}/render", post(files::render))
        .route("/v1/applications/{id}/files", get(files::files))
        .route("/v1/documents", get(files::documents))
        .route("/v1/applications/stages", get(tracking::stage_counts))
        .route("/v1/applications/{id}/stage", patch(tracking::set_stage))
        .route(
            "/v1/applications/{id}/applied",
            post(tracking::mark_applied),
        )
        .route(
            "/v1/applications/{id}/pipeline/retry",
            post(tracking::retry_pipeline),
        )
        .route(
            "/v1/applications/{id}/follow-ups",
            get(tracking::follow_ups).post(tracking::new_follow_up),
        )
        .route("/v1/reminders/{id}/snooze", post(tracking::snooze))
        .route("/v1/reminders/{id}/done", post(tracking::reminder_done))
        .route("/v1/home", get(home::home))
        .route("/v1/account/export", get(account::export))
        .route("/v1/account", delete(account::delete));

    let cors = cors_layer(&state.config.web);
    Router::new()
        .merge(public)
        .merge(resources)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::csrf::require_allowed_origin,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(request_timeout))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

/// CORS for the web app when it is served from another origin. Only the
/// origins in ALLOWED_ORIGINS may call with credentials (the session cookie).
/// A same-origin deployment never triggers CORS at all.
fn cors_layer(web: &config::WebConfig) -> CorsLayer {
    let origins: Vec<HeaderValue> = web
        .allowed_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600))
}

/// Headers every API response carries. The API serves JSON and files only,
/// so the content policy forbids everything; HSTS is sent when cookies are
/// Secure, i.e. behind HTTPS.
async fn security_headers(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    if state.config.web.cookie_secure {
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    resp
}

/// Longest a request may run. The slowest legitimate ones (an inline letter
/// or research call) take seconds; this only stops a stuck request from
/// holding a connection forever.
pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Largest JSON body accepted. The upload route raises its own limit.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

async fn request_timeout(
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match tokio::time::timeout(REQUEST_TIMEOUT, next.run(req)).await {
        Ok(resp) => resp,
        Err(_) => error::AppError::unavailable("timeout", "That took too long. Try again.")
            .into_response(),
    }
}
