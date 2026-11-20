//! New job, Workspace and the screens hanging off it.

use axum::extract::{Path, State};
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
    let (jd_text, url) = check_job(req.jd_text.as_deref(), req.url.as_deref())?;
    let started = launch(
        &state,
        &user,
        &jd_text,
        url.as_deref(),
        req.research,
        req.letter,
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(started)).into_response())
}

/// The pasted text or the link, checked: exactly one, and text of a
/// believable length.
fn check_job(
    jd_text: Option<&str>,
    url: Option<&str>,
) -> Result<(String, Option<String>), AppError> {
    match (
        jd_text.map(str::trim).filter(|s| !s.is_empty()),
        url.map(str::trim).filter(|s| !s.is_empty()),
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
            Ok((t.to_string(), None))
        }
        (None, Some(u)) => Ok((String::new(), Some(web::check_url(u)?))),
        (Some(_), Some(_)) => Err(AppError::validation(
            "jd_text",
            "Send the text or a link, not both.",
        )),
        (None, None) => Err(AppError::validation(
            "jd_text",
            "Paste the job description or a link to it.",
        )),
    }
}

/// Create the application from the master CV and queue its pipeline.
async fn launch(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    jd_text: &str,
    url: Option<&str>,
    research: bool,
    letter: bool,
) -> Result<serde_json::Value, AppError> {
    let master = crate::routes::cv::load_master(&state.db, user.id)
        .await?
        .ok_or_else(|| AppError::unprocessable("no_master_cv", "Upload your CV first."))?;
    usage::ensure_can_start_application(state, user.id, &user.plan).await?;

    let app_id: Uuid = sqlx::query_scalar(
        r#"
        insert into applications (user_id, jd_raw, source_url, base_cv_version_id, options, status)
        values ($1, $2, $3, $4, $5, 'draft')
        returning id
        "#,
    )
    .bind(user.id)
    .bind(jd_text)
    .bind(url)
    .bind(master.id)
    .bind(json!({ "research": research, "letter": letter }))
    .fetch_one(&state.db)
    .await?;
    // Two attempts: steps that finished are skipped on the retry.
    let job = jobs::enqueue_with_progress(
        &state.db,
        user.id,
        pipeline::KIND,
        json!({ "application_id": app_id }),
        2,
        Some(pipeline::initial_progress(research, letter)),
    )
    .await?;
    sqlx::query("update applications set pipeline_job_id = $3 where id = $1 and user_id = $2")
        .bind(app_id)
        .bind(user.id)
        .bind(job.id)
        .execute(&state.db)
        .await?;
    crate::digest::after_application_started(state, user.id, &user.plan).await;
    Ok(json!({ "application_id": app_id, "job_id": job.id, "progress": job.progress }))
}

/// POST /v1/applications/{id}/tailor-again: start a new application from a
/// desktop-era one's saved posting, with the current master CV. The old one
/// keeps its history and remembers the new one, so asking twice opens the
/// same new application instead of starting another.
pub async fn tailor_again(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    Path(app_id): Path<Uuid>,
) -> Result<Response, AppError> {
    let (jd_raw, source_url, base, done): (
        Option<String>,
        Option<String>,
        Option<Uuid>,
        Option<Uuid>,
    ) = sqlx::query_as(
        r#"
        select jd_raw, source_url, base_cv_version_id, (options->>'retailored_to')::uuid
        from applications where id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    if base.is_some() {
        return Err(AppError::conflict(
            "already_tailored",
            "This job is already tailored in your account.",
        ));
    }
    if let Some(new_id) = done {
        if crate::routes::ensure_application(&state.db, user.id, new_id)
            .await
            .is_ok()
        {
            return Ok(Json(json!({ "application_id": new_id })).into_response());
        }
    }
    let text = jd_raw.as_deref().map(str::trim).unwrap_or_default();
    let (jd_text, url) = if text.chars().count() >= MIN_JD_CHARS {
        check_job(Some(text), None)?
    } else if let Some(u) = source_url.as_deref() {
        check_job(None, Some(u))?
    } else {
        return Err(AppError::unprocessable(
            "no_saved_posting",
            "This job has no saved posting to tailor from. Paste it as a new job instead.",
        ));
    };
    let started = launch(&state, &user, &jd_text, url.as_deref(), true, true).await?;
    sqlx::query(
        r#"
        update applications
        set options = coalesce(options, '{}'::jsonb) || jsonb_build_object('retailored_to', $3::text)
        where id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .bind(started["application_id"].as_str())
    .execute(&state.db)
    .await?;
    Ok((StatusCode::ACCEPTED, Json(started)).into_response())
}

pub async fn ensure_owned(state: &AppState, uid: Uuid, app_id: Uuid) -> Result<(), AppError> {
    crate::routes::ensure_application(&state.db, uid, app_id).await
}
