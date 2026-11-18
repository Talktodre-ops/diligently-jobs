//! Setup milestones: the onboarding steps, each of which can wait.
//!
//! Every milestone is read from the account's data, so a step done some other
//! way (a CV uploaded from Profile, roles set in Settings) counts the same.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::AppState;

/// How long Hide keeps the setup card off Home.
pub const HIDE_FOR_DAYS: i32 = 7;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Setup {
    pub cv: bool,
    pub check: bool,
    pub targets: bool,
    pub first_application: bool,
    pub hidden_until: Option<DateTime<Utc>>,
    /// Something is left and the card is not hidden.
    pub show: bool,
}

pub async fn status(db: &PgPool, user_id: Uuid) -> Result<Setup, AppError> {
    let row: Option<(bool, bool, bool, bool, Option<DateTime<Utc>>)> = sqlx::query_as(
        r#"
        select p.master_cv_version_id is not null,
               p.cv_checked_at is not null,
               cardinality(p.target_roles) > 0,
               exists (select 1 from applications a where a.user_id = p.user_id),
               p.setup_hidden_until
        from profiles p where p.user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (cv, check, targets, first_application, hidden_until) =
        row.unwrap_or((false, false, false, false, None));
    let left = !(cv && check && targets && first_application);
    let hidden = hidden_until.is_some_and(|t| t > Utc::now());
    Ok(Setup {
        cv,
        check,
        targets,
        first_application,
        hidden_until: hidden_until.filter(|_| hidden),
        show: left && !hidden,
    })
}

/// POST /v1/setup/cv-checked: the user confirmed what we read from their CV.
pub async fn cv_checked(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    crate::routes::profile::ensure(&state.db, user.id).await?;
    sqlx::query(
        "update profiles set cv_checked_at = coalesce(cv_checked_at, now()) where user_id = $1",
    )
    .bind(user.id)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// POST /v1/setup/hide: keep the setup card off Home for a week, on every
/// device. It comes back afterwards if anything is still left.
pub async fn hide(State(state): State<AppState>, user: CurrentUser) -> Result<Response, AppError> {
    crate::routes::profile::ensure(&state.db, user.id).await?;
    sqlx::query("update profiles set setup_hidden_until = now() + make_interval(days => $2) where user_id = $1")
        .bind(user.id)
        .bind(HIDE_FOR_DAYS)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
