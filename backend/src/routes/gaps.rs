//! The Gaps screen: requirements the CV does not show, and the user's
//! answers. "I have this" turns their own words into a suggested bullet that
//! joins the tailored CV only once accepted; "I don't" becomes a note the
//! letter respects.

use axum::extract::State;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{CurrentUser, VerifiedUser};
use crate::error::AppError;
use crate::extract::{Json, Path};
use crate::prompts::gap_bullet;
use crate::{pipeline, validate, AppState};

#[derive(Debug, Serialize, FromRow)]
pub struct GapOut {
    pub id: Uuid,
    pub application_id: Uuid,
    pub requirement: String,
    pub importance: String,
    pub status: String,
    pub evidence: Option<String>,
    pub ask: Option<String>,
    pub answer: Option<String>,
    pub answer_text: Option<String>,
    pub suggested_bullet: Option<String>,
    pub bullet_status: Option<String>,
    pub target_entry: Option<i32>,
    pub updated_at: DateTime<Utc>,
}

const COLS: &str = "id, application_id, requirement, importance, status, evidence, ask, answer, answer_text, suggested_bullet, bullet_status, target_entry, updated_at";

async fn load(state: &AppState, uid: Uuid, id: Uuid) -> Result<GapOut, AppError> {
    sqlx::query_as::<_, GapOut>(&format!(
        "select {COLS} from application_gaps where id = $1 and user_id = $2"
    ))
    .bind(id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)
}

/// GET /v1/applications/{id}/gaps
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    crate::routes::ensure_application(&state.db, user.id, app_id).await?;
    let rows = sqlx::query_as::<_, GapOut>(&format!(
        "select {COLS} from application_gaps where application_id = $1 and user_id = $2 order by position"
    ))
    .bind(app_id)
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "gaps": rows })))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub have: bool,
    pub text: Option<String>,
    /// Which role the new bullet belongs to (0 is the most recent).
    pub entry: Option<i32>,
}

/// POST /v1/gaps/{id}/answer
pub async fn answer(
    State(state): State<AppState>,
    VerifiedUser(user): VerifiedUser,
    Path(id): Path<Uuid>,
    Json(a): Json<Answer>,
) -> Result<Json<Value>, AppError> {
    let gap = load(&state, user.id, id).await?;
    if !a.have {
        let note = validate::optional_text("text", a.text.as_deref(), 500)?;
        sqlx::query(
            r#"
            update application_gaps set answer = 'dont', answer_text = $3, suggested_bullet = null,
                bullet_status = null, target_entry = null
            where id = $1 and user_id = $2
            "#,
        )
        .bind(id)
        .bind(user.id)
        .bind(note)
        .execute(&state.db)
        .await?;
        return Ok(Json(json!({ "gap": load(&state, user.id, id).await? })));
    }

    let text = validate::required_text("text", a.text.as_deref().unwrap_or(""), 1000)?;
    if text.chars().count() < 15 {
        return Err(AppError::validation(
            "text",
            "Say a little more: where and how you did this.",
        ));
    }
    let (base, _) = pipeline::decided_doc(&state.db, user.id, gap.application_id).await?;
    let entry = a.entry.unwrap_or(0);
    let role = usize::try_from(entry)
        .ok()
        .and_then(|i| base.experience.get(i))
        .ok_or_else(|| AppError::validation("entry", "Choose one of the roles on your CV."))?;
    let context = format!("{} at {}", role.role, role.company);
    let res = crate::usage::call(
        &state,
        user.id,
        Some(gap.application_id),
        gap_bullet::request(&gap.requirement, &text, &context),
    )
    .await?;
    let bullet = gap_bullet::parse(res.value, &text).map_err(|e| {
        tracing::warn!(error = %e, "gap bullet rejected");
        AppError::unavailable("ai_failed", "That did not work. Try again.")
    })?;
    sqlx::query(
        r#"
        update application_gaps set answer = 'have', answer_text = $3, suggested_bullet = $4,
            bullet_status = case when $4::text is null then null else 'pending' end, target_entry = $5
        where id = $1 and user_id = $2
        "#,
    )
    .bind(id)
    .bind(user.id)
    .bind(&text)
    .bind(&bullet)
    .bind(entry)
    .execute(&state.db)
    .await?;
    let note = bullet.is_none().then_some(
        "That does not show the requirement yet. Add where you used it and what you did.",
    );
    Ok(Json(
        json!({ "gap": load(&state, user.id, id).await?, "note": note }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BulletDecision {
    pub bullet: String,
}

/// PATCH /v1/gaps/{id}: accept or discard the suggested bullet.
pub async fn decide(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(d): Json<BulletDecision>,
) -> Result<Json<Value>, AppError> {
    validate::one_of("bullet", &d.bullet, &["accept", "discard"])?;
    let gap = load(&state, user.id, id).await?;
    if gap.suggested_bullet.is_none() {
        return Err(AppError::unprocessable(
            "no_suggestion",
            "There is no suggested bullet to decide on.",
        ));
    }
    sqlx::query("update application_gaps set bullet_status = $3 where id = $1 and user_id = $2")
        .bind(id)
        .bind(user.id)
        .bind(if d.bullet == "accept" {
            "accepted"
        } else {
            "discarded"
        })
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "gap": load(&state, user.id, id).await? })))
}
