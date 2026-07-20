use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use thiserror::Error;

/// Top-level error type. Anything a handler can return as an error converts
/// into this, then into an HTTP response with a consistent JSON shape:
///
///   { "error": "<message>" }
#[derive(Debug, Error)]
pub enum AppError {
    #[error("unauthorized: {0}")]
    Unauthorized(&'static str),

    #[error("not found")]
    #[allow(dead_code)]
    NotFound,

    #[error("bad request: {0}")]
    #[allow(dead_code)]
    BadRequest(String),

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Db(_) | AppError::Internal(_) => {
                // Log the gory detail server-side; never leak it to the client.
                tracing::error!(error = %self, "internal error");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };

        let body = match &self {
            // 5xx errors get a generic message; 4xx errors echo their reason.
            AppError::Db(_) | AppError::Internal(_) => {
                json!({ "error": "internal error" })
            }
            _ => json!({ "error": self.to_string() }),
        };

        (status, Json(body)).into_response()
    }
}
