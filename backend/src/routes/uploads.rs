//! CV upload (Onboarding: Upload) and its progress (Onboarding: Running).

use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{CurrentUser, VerifiedUser};
use crate::docx_text;
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::jobs::{self, handlers::KIND_CV_PARSE};
use crate::AppState;

pub const MAX_UPLOAD_BYTES: usize = 5 * 1024 * 1024;
/// Shortest pasted CV worth sending to the model, in characters after trimming.
pub const MIN_TEXT_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pdf,
    Docx,
    /// Plain UTF-8 text; the web app sends pasted CV text as `cv.txt`.
    Txt,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Pdf => "pdf",
            Kind::Docx => "docx",
            Kind::Txt => "txt",
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Kind::Pdf => "application/pdf",
            Kind::Docx => DOCX_MIME,
            Kind::Txt => "text/plain; charset=utf-8",
        }
    }
}

const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// Decide what the file is from its name, declared type and first bytes. All
/// three must agree; a renamed executable fails the magic-byte check.
pub fn classify(filename: &str, declared: Option<&str>, bytes: &[u8]) -> Result<Kind, AppError> {
    let bad = |m: &str| AppError::validation("file", m.to_string());
    let lower = filename.to_ascii_lowercase();
    let kind = if lower.ends_with(".pdf") {
        Kind::Pdf
    } else if lower.ends_with(".docx") {
        Kind::Docx
    } else if lower.ends_with(".txt") {
        Kind::Txt
    } else {
        return Err(bad(
            "Upload a PDF, a Word (.docx) or a plain text (.txt) file.",
        ));
    };
    let declared_ok = match (
        kind,
        declared.map(|d| d.split(';').next().unwrap_or("").trim()),
    ) {
        (_, None) | (_, Some("application/octet-stream")) => true,
        (Kind::Pdf, Some(d)) => d == "application/pdf",
        (Kind::Docx, Some(d)) => d == DOCX_MIME,
        (Kind::Txt, Some(d)) => d == "text/plain",
    };
    if !declared_ok {
        return Err(bad("The file type does not match its name."));
    }
    if kind == Kind::Txt {
        let text = std::str::from_utf8(bytes)
            .ok()
            .filter(|t| !t.contains('\0'))
            .ok_or_else(|| bad("That text is not plain UTF-8. Paste it again or upload a PDF."))?;
        if text.trim().chars().count() < MIN_TEXT_CHARS {
            return Err(AppError::bad_field(
                "too_short",
                "file",
                format!(
                    "That is too short to be a CV. Paste the whole thing, at least {MIN_TEXT_CHARS} characters."
                ),
            ));
        }
        return Ok(kind);
    }
    let magic_ok = match kind {
        Kind::Pdf => bytes.starts_with(b"%PDF-"),
        Kind::Docx => docx_text::is_docx(bytes),
        Kind::Txt => true, // checked above
    };
    if !magic_ok {
        return Err(bad(
            "That file does not look like a real PDF or Word document.",
        ));
    }
    Ok(kind)
}

fn clean_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let s: String = base.chars().filter(|c| !c.is_control()).take(150).collect();
    if s.trim().is_empty() {
        "cv".to_string()
    } else {
        s
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct UploadRow {
    pub id: Uuid,
    pub filename: String,
    pub kind: String,
    pub size_bytes: i32,
    pub status: String,
    pub error: Option<String>,
    pub cv_version_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const UPLOAD_COLS: &str =
    "id, filename, kind, size_bytes, status, error, cv_version_id, created_at, updated_at";

/// POST /v1/cv/upload (multipart, one `file` field)
pub async fn upload(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    mut form: Multipart,
) -> Result<Response, AppError> {
    let mut file: Option<(String, Option<String>, Vec<u8>)> = None;
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("invalid upload: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let name = field.file_name().unwrap_or("cv").to_string();
        let declared = field.content_type().map(str::to_string);
        let bytes = field.bytes().await.map_err(|e| {
            AppError::validation(
                "file",
                format!("Could not read the file ({e}). The limit is 5 MB."),
            )
        })?;
        file = Some((name, declared, bytes.to_vec()));
        break;
    }
    let (name, declared, bytes) =
        file.ok_or_else(|| AppError::validation("file", "Choose a file to upload."))?;
    if bytes.is_empty() {
        return Err(AppError::validation("file", "That file is empty."));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::validation("file", "That file is over 5 MB."));
    }
    let kind = classify(&name, declared.as_deref(), &bytes)?;

    let id = Uuid::new_v4();
    let key = format!("u/{}/uploads/{id}.{}", user.id, kind.as_str());
    let mime = kind.mime();
    let size = bytes.len() as i32;
    state.r2.put(&key, bytes, mime).await?;

    let row = sqlx::query_as::<_, UploadRow>(&format!(
        r#"
        insert into cv_uploads (id, user_id, filename, kind, size_bytes, storage_key)
        values ($1, $2, $3, $4, $5, $6)
        returning {UPLOAD_COLS}
        "#
    ))
    .bind(id)
    .bind(user.id)
    .bind(clean_filename(&name))
    .bind(kind.as_str())
    .bind(size)
    .bind(&key)
    .fetch_one(&state.db)
    .await?;
    // One attempt: the AI client already retries transient errors, and a
    // second full parse would bill twice for the same file.
    let job = jobs::enqueue(
        &state.db,
        user.id,
        KIND_CV_PARSE,
        json!({ "upload_id": id }),
        1,
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "upload": row, "job_id": job.id })),
    )
        .into_response())
}

/// GET /v1/cv/uploads/{id}
pub async fn get_upload(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = sqlx::query_as::<_, UploadRow>(&format!(
        "select {UPLOAD_COLS} from cv_uploads where id = $1 and user_id = $2"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "upload": row })))
}
