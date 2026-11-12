//! New job, Workspace and the screens hanging off it.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::VerifiedUser;
use crate::error::AppError;
use crate::extract::Json;
use crate::{jobs, pipeline, usage, web, AppState};

pub const MIN_JD_CHARS: usize = 200;
pub const MAX_JD_CHARS: usize = 30_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    pub jd_text: Option<String>,
    pub url: Option<String>,
    #[serde(default = "yes")]
    pub research: bool,
    #[serde(default = "yes")]
    pub letter: bool,
}

fn yes() -> bool {
    true
}

/// POST /v1/applications/start: paste a job or a link, get the pipeline
/// started. The response carries the job id the Running screen polls.
pub async fn start(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    Json(req): Json<StartRequest>,
) -> Result<Response, AppError> {
    let (jd_text, url) = match (
        req.jd_text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        req.url.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(t), None) => {
            let n = t.chars().count();
            if n < MIN_JD_CHARS {
                return Err(AppError::validation(
                    "jd_text",
                    "That looks short for a job description. Paste the whole posting.",
                ));
            }
            if n > MAX_JD_CHARS {
                return Err(AppError::validation(
                    "jd_text",
                    "That is longer than a job description can be.",
                ));
            }
            (t.to_string(), None)
        }
        (None, Some(u)) => (String::new(), Some(web::check_url(u)?)),
        (Some(_), Some(_)) => {
            return Err(AppError::validation(
                "jd_text",
                "Send the text or a link, not both.",
            ))
        }
        (None, None) => {
            return Err(AppError::validation(
                "jd_text",
                "Paste the job description or a link to it.",
            ))
        }
    };

    let master = crate::routes::cv::load_master(&state.db, user.id)
        .await?
        .ok_or_else(|| AppError::unprocessable("no_master_cv", "Upload your CV first."))?;
    usage::ensure_can_start_application(&state, user.id, &user.plan).await?;

    let app_id: Uuid = sqlx::query_scalar(
        r#"
        insert into applications (user_id, jd_raw, source_url, base_cv_version_id, options, status)
        values ($1, $2, $3, $4, $5, 'draft')
        returning id
        "#,
    )
    .bind(user.id)
    .bind(&jd_text)
    .bind(&url)
    .bind(master.id)
    .bind(json!({ "research": req.research, "letter": req.letter }))
    .fetch_one(&state.db)
    .await?;
    // Two attempts: steps that finished are skipped on the retry.
    let job = jobs::enqueue_with_progress(
        &state.db,
        user.id,
        pipeline::KIND,
        json!({ "application_id": app_id }),
        2,
        Some(pipeline::initial_progress(req.research, req.letter)),
    )
    .await?;
    sqlx::query("update applications set pipeline_job_id = $3 where id = $1 and user_id = $2")
        .bind(app_id)
        .bind(user.id)
        .bind(job.id)
        .execute(&state.db)
        .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "application_id": app_id, "job_id": job.id, "progress": job.progress })),
    )
        .into_response())
}

pub async fn ensure_owned(state: &AppState, uid: Uuid, app_id: Uuid) -> Result<(), AppError> {
    crate::routes::ensure_application(&state.db, uid, app_id).await
}
