//! The master CV: the user's own CV that every tailored CV starts from.

use axum::extract::State;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::extract::Json;
use crate::render::resume::{self, Issue, ResumeDoc};
use crate::AppState;

#[derive(Debug, FromRow)]
pub struct MasterRow {
    pub id: Uuid,
    pub sections: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

/// The current master CV version for a user, if any.
pub async fn load_master(db: &PgPool, user_id: Uuid) -> Result<Option<MasterRow>, AppError> {
    Ok(sqlx::query_as::<_, MasterRow>(
        r#"
        select c.id, c.sections, c.created_at
        from profiles p join cv_versions c on c.id = p.master_cv_version_id and c.user_id = p.user_id
        where p.user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

/// Store `doc` as a new immutable version and point the profile at it.
pub async fn save_master(
    db: &PgPool,
    user_id: Uuid,
    doc: &ResumeDoc,
    label: &str,
) -> Result<Uuid, AppError> {
    resume::validate(doc).map_err(|m| AppError::validation("doc", m))?;
    let sections = serde_json::to_value(doc).map_err(anyhow::Error::from)?;
    super::profile::ensure(db, user_id).await?;
    let mut tx = db.begin().await?;
    let previous: Option<Uuid> =
        sqlx::query_scalar("select master_cv_version_id from profiles where user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
    let id: Uuid = sqlx::query_scalar(
        r#"
        insert into cv_versions (user_id, application_id, sections, label, based_on_id)
        values ($1, null, $2, $3, $4)
        returning id
        "#,
    )
    .bind(user_id)
    .bind(&sections)
    .bind(label)
    .bind(previous)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("update profiles set master_cv_version_id = $2 where user_id = $1")
        .bind(user_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(id)
}

#[derive(Serialize)]
pub struct MasterOut {
    pub id: Uuid,
    pub doc: ResumeDoc,
    pub issues: Vec<Issue>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct Envelope {
    cv: MasterOut,
}

fn to_out(row: MasterRow) -> Result<MasterOut, AppError> {
    let doc = resume::parse_resume_doc(&row.sections).ok_or_else(|| {
        // Only legacy flat-section rows fail here; the API never writes them.
        AppError::unprocessable(
            "master_cv_legacy_format",
            "This CV is in an old format. Upload it again to continue.",
        )
    })?;
    Ok(MasterOut {
        id: row.id,
        issues: resume::check_issues(&doc),
        doc,
        updated_at: row.created_at,
    })
}

fn no_master() -> AppError {
    AppError::unprocessable("no_master_cv", "Upload your CV first.")
}

/// GET /v1/cv/master
pub async fn get_master(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<impl Serialize>, AppError> {
    let row = load_master(&state.db, user.id)
        .await?
        .ok_or_else(no_master)?;
    Ok(Json(Envelope { cv: to_out(row)? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutMaster {
    pub doc: ResumeDoc,
}

/// PUT /v1/cv/master. Saves edits as a new version.
pub async fn put_master(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<PutMaster>,
) -> Result<Json<impl Serialize>, AppError> {
    save_master(&state.db, user.id, &req.doc, "master").await?;
    let row = load_master(&state.db, user.id)
        .await?
        .ok_or_else(no_master)?;
    Ok(Json(Envelope { cv: to_out(row)? }))
}
