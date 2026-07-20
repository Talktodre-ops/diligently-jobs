use crate::error::AppError;
use crate::AppState;
use anyhow::Context;
use aws_sdk_s3::presigning::PresigningConfig;
use axum::{extract::State, Json};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Bucket key convention. Keep clients from picking weird paths so we can
/// reason about R2 listings later.
///   cvs/<id>.{pdf,docx}
///   interviews/<id>.wav
///   letters/<id>.pdf
///   screenshots/<id>.png
/// Any other prefix is rejected. (Server-side defense — the caller could
/// theoretically write anywhere with the bucket-wide R2 token, but we never
/// SIGN a URL for them outside this convention.)
const ALLOWED_KEY_PREFIXES: &[&str] = &[
    "cvs/",
    "interviews/",
    "letters/",
    "screenshots/",
    "exports/",
];

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

/// POST /v1/blobs/presign-upload
///
/// Returns a signed URL the client uploads to directly via HTTP PUT. We don't
/// proxy bytes through the backend — saves CPU + bandwidth, and means a
/// 100MB interview recording uploads as fast as the client's link allows.
pub async fn presign_upload(
    State(state): State<AppState>,
    Json(req): Json<PresignRequest>,
) -> Result<Json<PresignResponse>, AppError> {
    validate_key(&req.key)?;
    let ttl = ttl_from_request(req.ttl_seconds)?;

    let mut put = state
        .r2
        .client
        .put_object()
        .bucket(&state.r2.bucket)
        .key(&req.key);
    if let Some(ct) = &req.content_type {
        put = put.content_type(ct);
    }

    let presigning = PresigningConfig::expires_in(ttl)
        .context("invalid presigning TTL")?;
    let signed = put
        .presigned(presigning)
        .await
        .context("failed to sign upload URL")?;

    Ok(Json(PresignResponse {
        url: signed.uri().to_string(),
        key: req.key,
        expires_at: Utc::now() + ChronoDuration::from_std(ttl).unwrap_or_default(),
    }))
}

/// POST /v1/blobs/presign-download
///
/// Returns a signed URL the client fetches via HTTP GET. Same pattern as
/// upload but for retrieval — useful for "download my application PDF" etc.
pub async fn presign_download(
    State(state): State<AppState>,
    Json(req): Json<PresignRequest>,
) -> Result<Json<PresignResponse>, AppError> {
    validate_key(&req.key)?;
    let ttl = ttl_from_request(req.ttl_seconds)?;

    let presigning = PresigningConfig::expires_in(ttl)
        .context("invalid presigning TTL")?;
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

fn validate_key(key: &str) -> Result<(), AppError> {
    if key.is_empty() || key.contains("..") || key.starts_with('/') {
        return Err(AppError::BadRequest(format!("invalid blob key: {key}")));
    }
    if !ALLOWED_KEY_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err(AppError::BadRequest(format!(
            "blob key must start with one of: {}",
            ALLOWED_KEY_PREFIXES.join(", ")
        )));
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
