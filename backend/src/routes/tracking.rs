//! After the application goes out: stages (the Jobs tabs), "I sent it" with
//! a follow-up reminder, and pipeline retry.

use axum::extract::State;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::{jobs, pipeline, validate, AppState};

pub const STAGES: &[&str] = &["saved", "applied", "interviewing", "offer", "closed"];

pub async fn event(
    db: &PgPool,
    uid: Uuid,
    app_id: Uuid,
    kind: &str,
    payload: Value,
) -> Result<(), AppError> {
    sqlx::query(
        "insert into events (kind, payload, application_id, user_id) values ($1, $2, $3, $4)",
    )
    .bind(kind)
    .bind(payload)
    .bind(app_id)
    .bind(uid)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageRequest {
    pub stage: String,
}

/// PATCH /v1/applications/{id}/stage. Closing an application cancels its
/// pending reminders.
pub async fn set_stage(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
    Json(req): Json<StageRequest>,
) -> Result<Json<Value>, AppError> {
    validate::one_of("stage", &req.stage, STAGES)?;
    let previous: String = sqlx::query_scalar(
        r#"
        with old as (select stage from applications where id = $1 and user_id = $2)
        update applications a set stage = $3,
            submitted_at = case when $3 = 'applied' then coalesce(a.submitted_at, now()) else a.submitted_at end
        from old where a.id = $1 and a.user_id = $2
        returning old.stage
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .bind(&req.stage)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    if req.stage == "closed" || req.stage == "offer" {
        sqlx::query("update reminders set status = 'cancelled' where application_id = $1 and user_id = $2 and status = 'scheduled'")
            .bind(app_id)
            .bind(user.id)
            .execute(&state.db)
            .await?;
    }
    if previous != req.stage {
        event(
            &state.db,
            user.id,
            app_id,
            "stage_changed",
            json!({ "from": previous, "to": req.stage }),
        )
        .await?;
    }
    Ok(Json(
        json!({ "application_id": app_id, "stage": req.stage }),
    ))
}

#[derive(Debug, Serialize, FromRow)]
pub struct ReminderOut {
    pub id: Uuid,
    pub application_id: Uuid,
    pub due_at: DateTime<Utc>,
    pub status: String,
    pub sent_at: Option<DateTime<Utc>>,
}

pub const REMINDER_COLS: &str = "id, application_id, due_at, status, sent_at";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppliedRequest {
    /// Days until the follow-up reminder (the Send screen offers 5, 7, 10).
    /// None means no reminder.
    pub reminder_days: Option<i64>,
}

/// POST /v1/applications/{id}/applied: the user confirms they sent it.
/// Marks the application applied and schedules one follow-up reminder,
/// replacing any earlier scheduled one.
pub async fn mark_applied(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
    Json(req): Json<AppliedRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(d) = req.reminder_days {
        if !(1..=30).contains(&d) {
            return Err(AppError::validation(
                "reminder_days",
                "Choose between 1 and 30 days.",
            ));
        }
    }
    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "update applications set stage = 'applied', submitted_at = coalesce(submitted_at, now()) where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("update reminders set status = 'cancelled' where application_id = $1 and user_id = $2 and status = 'scheduled'")
        .bind(app_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    let reminder = match req.reminder_days {
        Some(d) => Some(
            sqlx::query_as::<_, ReminderOut>(&format!(
                "insert into reminders (user_id, application_id, due_at) values ($1, $2, $3) returning {REMINDER_COLS}"
            ))
            .bind(user.id)
            .bind(app_id)
            .bind(Utc::now() + Duration::days(d))
            .fetch_one(&mut *tx)
            .await?,
        ),
        None => None,
    };
    tx.commit().await?;
    event(
        &state.db,
        user.id,
        app_id,
        "applied",
        json!({ "reminder_days": req.reminder_days }),
    )
    .await?;
    Ok(Json(
        json!({ "application_id": app_id, "stage": "applied", "reminder": reminder }),
    ))
}

/// GET /v1/applications/stages: counts for the Jobs tabs.
pub async fn stage_counts(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "select stage, count(*) from applications where user_id = $1 group by stage",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let mut counts = serde_json::Map::new();
    for s in STAGES {
        let n = rows
            .iter()
            .find(|(k, _)| k == s)
            .map(|(_, n)| *n)
            .unwrap_or(0);
        counts.insert((*s).to_string(), json!(n));
    }
    Ok(Json(json!({ "stages": counts })))
}

/// POST /v1/applications/{id}/pipeline/retry: queue the pipeline again after
/// it failed. Finished steps are skipped, so only the failed work reruns.
pub async fn retry_pipeline(
    State(state): State<AppState>,
    crate::auth::VerifiedUser(user): crate::auth::VerifiedUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let (job_id, options): (Option<Uuid>, Value) = sqlx::query_as(
        "select pipeline_job_id, options from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    if let Some(id) = job_id {
        if let Some(j) = jobs::get_by_id(&state.db, user.id, id).await? {
            if j.status != "failed" {
                return Err(AppError::conflict(
                    "pipeline_not_failed",
                    "This job is still running or already finished.",
                ));
            }
        }
    }
    let research = options
        .get("research")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let letter = options
        .get("letter")
        .and_then(Value::as_bool)
        .unwrap_or(true);
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
    Ok(Json(json!({ "job_id": job.id, "progress": job.progress })))
}
