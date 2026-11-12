//! Workspace brief, Review (rewrites and summary), the tailored CV view and
//! rescoring.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{CurrentUser, VerifiedUser};
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::jobs::{self, handlers::KIND_ATS_SCORE};
use crate::pipeline;
use crate::render::resume;
use crate::validate;
use crate::AppState;

#[derive(Debug, FromRow)]
struct AppHead {
    id: Uuid,
    company: Option<String>,
    role: Option<String>,
    status: String,
    source_url: Option<String>,
    jd_analysis: Option<Value>,
    tailored_summary: Option<String>,
    summary_status: String,
    pipeline_job_id: Option<Uuid>,
    created_at: DateTime<Utc>,
}

async fn head(state: &AppState, uid: Uuid, app_id: Uuid) -> Result<AppHead, AppError> {
    sqlx::query_as::<_, AppHead>(
        r#"
        select id, company, role, status, source_url, jd_analysis, tailored_summary, summary_status,
               pipeline_job_id, created_at
        from applications where id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)
}

/// GET /v1/applications/{id}/brief: everything the Workspace screen shows.
pub async fn brief(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let h = head(&state, user.id, app_id).await?;
    let db = &state.db;
    let job = match h.pipeline_job_id {
        Some(id) => jobs::get_by_id(db, user.id, id).await?,
        None => None,
    };
    let score = pipeline::score_view(db, user.id, app_id).await?;
    let (total, pending, accepted, kept, edited): (i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        select count(*), count(*) filter (where status = 'pending'), count(*) filter (where status = 'accepted'),
               count(*) filter (where status = 'kept'), count(*) filter (where status = 'edited')
        from tailored_bullets where application_id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_one(db)
    .await?;
    let (gaps_total, missing, partial, unanswered): (i64, i64, i64, i64) = sqlx::query_as(
        r#"
        select count(*), count(*) filter (where status = 'missing'), count(*) filter (where status = 'partial'),
               count(*) filter (where status <> 'covered' and answer is null)
        from application_gaps where application_id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_one(db)
    .await?;
    let top_gaps: Vec<String> = sqlx::query_scalar(
        "select requirement from application_gaps where application_id = $1 and user_id = $2 and status <> 'covered' order by status = 'missing' desc, position limit 3",
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_all(db)
    .await?;
    let research: Option<Value> = sqlx::query_scalar(
        "select brief from company_research where application_id = $1 and user_id = $2 order by created_at desc limit 1",
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_optional(db)
    .await?;
    let letter: Option<(Uuid, String, i32)> = sqlx::query_as(
        r#"
        select id, tone, array_length(regexp_split_to_array(trim(body), '\s+'), 1)
        from cover_letters where application_id = $1 and user_id = $2 order by generated_at desc limit 1
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_optional(db)
    .await?;
    let analysis = h.jd_analysis.clone().unwrap_or(Value::Null);
    Ok(Json(json!({
        "application": {
            "id": h.id, "company": h.company, "role": h.role, "status": h.status,
            "source_url": h.source_url, "created_at": h.created_at,
            "location": analysis.get("location"), "summary": analysis.get("summary"),
        },
        "pipeline": job.map(|j| json!({ "job_id": j.id, "status": j.status, "progress": j.progress })),
        "score": score,
        "rewrites": { "total": total, "pending": pending, "accepted": accepted, "kept": kept, "edited": edited },
        "summary": { "proposed": h.tailored_summary.is_some(), "status": h.summary_status },
        "gaps": { "total": gaps_total, "missing": missing, "partial": partial, "unanswered": unanswered, "top": top_gaps },
        "research": research.map(|b| json!({ "overview": b.get("overview"), "talking_points": b.get("talking_points").and_then(Value::as_array).map(|a| a.len()) })),
        "letter": letter.map(|(id, tone, words)| json!({ "id": id, "tone": tone, "words": words })),
    })))
}

#[derive(Debug, Serialize, FromRow)]
pub struct RewriteOut {
    pub id: Uuid,
    pub bullet_id: Option<String>,
    pub section: String,
    pub original: String,
    pub rewrite: String,
    pub why: Option<String>,
    pub needs_number: bool,
    pub status: String,
    pub final_text: Option<String>,
}

/// GET /v1/applications/{id}/rewrites
pub async fn list_rewrites(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let h = head(&state, user.id, app_id).await?;
    let rows = sqlx::query_as::<_, RewriteOut>(
        r#"
        select id, bullet_id, section, original, rewrite, why, needs_number, status, final_text
        from tailored_bullets where application_id = $1 and user_id = $2 order by position, created_at
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let (base, _) = pipeline::decided_doc(&state.db, user.id, app_id).await?;
    Ok(Json(json!({
        "summary": h.tailored_summary.as_ref().map(|p| json!({ "original": base.summary, "proposed": p, "status": h.summary_status })),
        "rewrites": rows,
        "score": pipeline::score_view(&state.db, user.id, app_id).await?,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub action: String,
    pub text: Option<String>,
}

/// PATCH /v1/rewrites/{id}: accept the rewrite, keep the original, or edit.
pub async fn decide_rewrite(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(d): Json<Decision>,
) -> Result<Json<Value>, AppError> {
    validate::one_of("action", &d.action, &["accept", "keep", "edit"])?;
    let (status, final_text) = match d.action.as_str() {
        "accept" => ("accepted", None),
        "keep" => ("kept", None),
        _ => {
            let t = validate::required_text(
                "text",
                d.text.as_deref().unwrap_or(""),
                resume::limits::BULLET,
            )?;
            ("edited", Some(t))
        }
    };
    let app_id: Uuid = sqlx::query_scalar(
        r#"
        update tailored_bullets set status = $3, final_text = $4, decided_at = now()
        where id = $1 and user_id = $2 returning application_id
        "#,
    )
    .bind(id)
    .bind(user.id)
    .bind(status)
    .bind(final_text)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let row = sqlx::query_as::<_, RewriteOut>(
        "select id, bullet_id, section, original, rewrite, why, needs_number, status, final_text from tailored_bullets where id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(
        json!({ "rewrite": row, "score": pipeline::score_view(&state.db, user.id, app_id).await? }),
    ))
}

/// PATCH /v1/applications/{id}/summary: accept, keep the original, or edit.
pub async fn decide_summary(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
    Json(d): Json<Decision>,
) -> Result<Json<Value>, AppError> {
    validate::one_of("action", &d.action, &["accept", "keep", "edit"])?;
    let h = head(&state, user.id, app_id).await?;
    if h.tailored_summary.is_none() && d.action != "edit" {
        return Err(AppError::unprocessable(
            "no_summary",
            "There is no proposed summary for this job.",
        ));
    }
    let text = if d.action == "edit" {
        Some(validate::required_text(
            "text",
            d.text.as_deref().unwrap_or(""),
            resume::limits::SUMMARY,
        )?)
    } else {
        None
    };
    sqlx::query(
        r#"
        update applications set summary_status = $3, tailored_summary = coalesce($4, tailored_summary)
        where id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .bind(if d.action == "keep" { "kept" } else { "accepted" })
    .bind(text)
    .execute(&state.db)
    .await?;
    Ok(Json(
        json!({ "score": pipeline::score_view(&state.db, user.id, app_id).await? }),
    ))
}

/// GET /v1/applications/{id}/cv: the tailored CV as decided so far, for the
/// Read view of CV preview.
pub async fn tailored_cv(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let (_, doc) = pipeline::decided_doc(&state.db, user.id, app_id).await?;
    let paper = crate::routes::profile::paper_size(&state.db, user.id).await?;
    Ok(Json(
        json!({ "doc": doc, "issues": resume::check_issues(&doc), "paper_size": paper }),
    ))
}

/// POST /v1/applications/{id}/rescore: real ATS score of the decided CV.
pub async fn rescore(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    Path(app_id): Path<Uuid>,
) -> Result<Response, AppError> {
    let cv_id = pipeline::materialize(&state.db, user.id, app_id).await?;
    let payload = json!({ "application_id": app_id });
    let job = match jobs::find_active(&state.db, user.id, KIND_ATS_SCORE, &payload).await? {
        Some(j) => j,
        None => jobs::enqueue(&state.db, user.id, KIND_ATS_SCORE, payload, 1).await?,
    };
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "job_id": job.id, "cv_version_id": cv_id })),
    )
        .into_response())
}
