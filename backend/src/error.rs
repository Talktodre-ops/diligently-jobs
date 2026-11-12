use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

/// Top-level error type. Every handler error converts into this, then into a
/// response with one JSON shape:
///
///   { "error": { "code": "snake_case", "message": "...", "field": "optional" } }
///
/// `code` is stable and meant for the client to branch on; `message` is for
/// people. 5xx errors are logged server-side and never echo their detail.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Unauthorized(&'static str),

    #[error("{message}")]
    Forbidden { code: &'static str, message: String },

    #[error("not found")]
    NotFound,

    #[error("{0}")]
    BadRequest(String),

    /// A specific input failed validation.
    #[error("{message}")]
    Validation {
        field: &'static str,
        message: String,
    },

    /// A request that is well formed but conflicts with current state, for
    /// example an email that is already registered.
    #[error("{message}")]
    Conflict { code: &'static str, message: String },

    /// Well formed and authorized, but cannot be processed as asked (a limit
    /// reached, a feature not configured, email not verified yet).
    #[error("{message}")]
    Unprocessable { code: &'static str, message: String },

    #[error("too many requests")]
    RateLimited { retry_after_secs: u64 },

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn validation(field: &'static str, message: impl Into<String>) -> Self {
        AppError::Validation {
            field,
            message: message.into(),
        }
    }

    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        AppError::Forbidden {
            code,
            message: message.into(),
        }
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        AppError::Conflict {
            code,
            message: message.into(),
        }
    }

    pub fn unprocessable(code: &'static str, message: impl Into<String>) -> Self {
        AppError::Unprocessable {
            code,
            message: message.into(),
        }
    }

    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden { code, .. } => (StatusCode::FORBIDDEN, code),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::Validation { .. } => (StatusCode::UNPROCESSABLE_ENTITY, "invalid_input"),
            AppError::Conflict { code, .. } => (StatusCode::CONFLICT, code),
            AppError::Unprocessable { code, .. } => (StatusCode::UNPROCESSABLE_ENTITY, code),
            AppError::RateLimited { .. } => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            AppError::Db(_) | AppError::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let body = match &self {
            AppError::Db(_) | AppError::Internal(_) => {
                // Log the detail server-side; never leak it to the client.
                tracing::error!(error = %self, "internal error");
                json!({ "error": { "code": code, "message": "Something went wrong on our side." } })
            }
            AppError::Validation { field, message } => {
                json!({ "error": { "code": code, "message": message, "field": field } })
            }
            AppError::RateLimited { .. } => {
                json!({ "error": { "code": code, "message": "Too many attempts. Wait a little and try again." } })
            }
            other => json!({ "error": { "code": code, "message": other.to_string() } }),
        };

        let mut resp = (status, axum::Json(body)).into_response();
        if let AppError::RateLimited { retry_after_secs } = self {
            if let Ok(v) = HeaderValue::from_str(&retry_after_secs.to_string()) {
                resp.headers_mut().insert(header::RETRY_AFTER, v);
            }
        }
        resp
    }
}

impl From<JsonRejection> for AppError {
    fn from(rej: JsonRejection) -> Self {
        AppError::BadRequest(format!("invalid JSON body: {}", rej.body_text()))
    }
}

impl From<PathRejection> for AppError {
    fn from(rej: PathRejection) -> Self {
        AppError::BadRequest(format!("invalid path: {}", rej.body_text()))
    }
}

impl From<QueryRejection> for AppError {
    fn from(rej: QueryRejection) -> Self {
        AppError::BadRequest(format!("invalid query: {}", rej.body_text()))
    }
}
