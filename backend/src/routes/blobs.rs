use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::extract::Json;
use crate::AppState;
use anyhow::Context;
use aws_sdk_s3::presigning::PresigningConfig;
use axum::extract::State;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Bucket key convention: every object belongs to one user and lives under
/// `u/{user_id}/{subdir}/...`, for example `u/<id>/cvs/<cv id>.pdf`. URLs are
/// only ever signed for the caller's own prefix and these subdirectories.
const ALLOWED_SUBDIRS: &[&str] = &["cvs/", "letters/", "uploads/", "exports/", "interviews/"];

/// Default presigning TTL when the caller doesn't specify one.
const DEFAULT_TTL_SECONDS: u64 = 300; // 5 minutes
/// Hard upper bound — R2 / S3 presigned URLs cap at 7 days.
const MAX_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Deserialize)]
pub struct PresignRequest {
    pub key: String,
    /// Required on uploads, ignored on downloads.
    pub content_type: Option<String>,
    pub ttl_seconds: Option<u64>,
    /// Download only: sets the response Content-Disposition (e.g.
    /// `attachment; filename="cv.pdf"`) so the browser/webview downloads the
    /// file instead of opening it inline in a PDF viewer.
    pub content_disposition: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PresignResponse {
    pub url: String,
    pub key: String,
    pub expires_at: DateTime<Utc>,
}

/// POST /v1/blobs/presign-download
///
/// Returns a short-lived signed URL for one of the caller's own files.
pub async fn presign_download(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<PresignRequest>,
) -> Result<Json<PresignResponse>, AppError> {
    validate_key(user.id, &req.key)?;
    let ttl = ttl_from_request(req.ttl_seconds)?;

    let presigning = PresigningConfig::expires_in(ttl).context("invalid presigning TTL")?;
    let mut get = state
        .r2
        .client
        .get_object()
        .bucket(&state.r2.bucket)
        .key(&req.key);
    if let Some(cd) = &req.content_disposition {
        // Signed into the URL as response-content-disposition — forces a real
        // download rather than inline PDF preview.
        get = get.response_content_disposition(cd);
    }
    let signed = get
        .presigned(presigning)
        .await
        .context("failed to sign download URL")?;

    Ok(Json(PresignResponse {
        url: signed.uri().to_string(),
        key: req.key,
        expires_at: Utc::now() + ChronoDuration::from_std(ttl).unwrap_or_default(),
    }))
}

fn validate_key(user_id: uuid::Uuid, key: &str) -> Result<(), AppError> {
    if key.is_empty() || key.contains("..") || key.contains('\\') || key.starts_with('/') {
        return Err(AppError::BadRequest("invalid file key".to_string()));
    }
    // Every object a user owns lives under u/{their id}/. Anything else is
    // reported as not found rather than forbidden, so keys do not leak.
    let prefix = format!("u/{user_id}/");
    let rest = key.strip_prefix(&prefix).ok_or(AppError::NotFound)?;
    if !ALLOWED_SUBDIRS.iter().any(|p| rest.starts_with(p)) {
        return Err(AppError::NotFound);
    }
    Ok(())
}

fn ttl_from_request(ttl_seconds: Option<u64>) -> Result<Duration, AppError> {
    let secs = ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
    if secs == 0 {
        return Err(AppError::BadRequest("ttl_seconds must be > 0".to_string()));
    }
    if secs > MAX_TTL_SECONDS {
        return Err(AppError::BadRequest(format!(
            "ttl_seconds exceeds max of {MAX_TTL_SECONDS} (7 days)"
        )));
    }
    Ok(Duration::from_secs(secs))
}
