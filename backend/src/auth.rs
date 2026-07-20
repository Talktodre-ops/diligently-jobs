use crate::error::AppError;
use axum::{
    extract::{Request, State},
    http::header::AUTHORIZATION,
    middleware::Next,
    response::Response,
};
use subtle::ConstantTimeEq;

use crate::AppState;

/// Bearer-token middleware. Single-user model: there's exactly one valid token
/// in the env (`BEARER_TOKEN`); every request must present it as
/// `Authorization: Bearer <token>`. Compared in constant time to avoid timing
/// side-channels on the secret.
pub async fn require_bearer(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let header = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or(AppError::Unauthorized("missing Authorization header"))?;

    let token = header
        .strip_prefix("Bearer ")
        .ok_or(AppError::Unauthorized("Authorization header must be `Bearer <token>`"))?;

    let expected = state.config.bearer_token.as_bytes();
    let provided = token.as_bytes();

    // Constant-time compare. Differing lengths still mean reject, but we run the
    // comparison anyway against a sentinel of the expected length so the timing
    // doesn't leak the length of the secret.
    let lengths_match: bool = expected.len() == provided.len();
    let probe = if lengths_match { provided } else { expected };
    let matches: bool = expected.ct_eq(probe).into();

    if !(lengths_match && matches) {
        return Err(AppError::Unauthorized("invalid bearer token"));
    }

    Ok(next.run(req).await)
}
