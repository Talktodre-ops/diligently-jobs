//! The signed-in user's profile and preferences (Onboarding, Profile and
//! Settings screens). A profile row is created on first read with defaults.

use axum::extract::State;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::extract::Json;
use crate::validate;
use crate::AppState;

pub const PAPER_SIZES: &[&str] = &["a4", "letter"];
const THEMES: &[&str] = &["system", "light", "dark"];
const WORK_SETTINGS: &[&str] = &["remote", "hybrid", "onsite"];
const ONBOARDING_STEPS: &[&str] = &["upload", "check", "targets", "done"];
const MAX_TARGET_ROLES: usize = 10;

#[derive(Debug, FromRow)]
struct ProfileRow {
    full_name: Option<String>,
    headline: Option<String>,
    location: Option<String>,
    target_roles: Vec<String>,
    work_settings: Vec<String>,
    paper_size: String,
    theme: String,
    notify_follow_ups: bool,
    notify_interview_prep: bool,
    notify_product_news: bool,
    onboarding_step: String,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct Notifications {
    pub follow_ups: bool,
    pub interview_prep: bool,
    pub product_news: bool,
}

#[derive(Debug, Serialize)]
pub struct ProfileOut {
    pub full_name: Option<String>,
    pub headline: Option<String>,
    pub location: Option<String>,
    pub target_roles: Vec<String>,
    pub work_settings: Vec<String>,
    pub paper_size: String,
    pub theme: String,
    pub notifications: Notifications,
    pub onboarding_step: String,
    pub updated_at: DateTime<Utc>,
}

impl From<ProfileRow> for ProfileOut {
    fn from(r: ProfileRow) -> Self {
        ProfileOut {
            full_name: r.full_name,
            headline: r.headline,
            location: r.location,
            target_roles: r.target_roles,
            work_settings: r.work_settings,
            paper_size: r.paper_size,
            theme: r.theme,
            notifications: Notifications {
                follow_ups: r.notify_follow_ups,
                interview_prep: r.notify_interview_prep,
                product_news: r.notify_product_news,
            },
            onboarding_step: r.onboarding_step,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Serialize)]
struct Envelope {
    profile: ProfileOut,
}

const SELECT: &str = r#"
    select full_name, headline, location, target_roles, work_settings, paper_size, theme,
           notify_follow_ups, notify_interview_prep, notify_product_news, onboarding_step, updated_at
    from profiles where user_id = $1
"#;

/// Create the profile with defaults if it does not exist yet.
pub async fn ensure(db: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query("insert into profiles (user_id) values ($1) on conflict (user_id) do nothing")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// The user's preferred paper size, `a4` when unset.
pub async fn paper_size(db: &PgPool, user_id: Uuid) -> Result<String, AppError> {
    let size: Option<String> =
        sqlx::query_scalar("select paper_size from profiles where user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(size.unwrap_or_else(|| "a4".to_string()))
}

async fn load(db: &PgPool, user_id: Uuid) -> Result<ProfileOut, AppError> {
    ensure(db, user_id).await?;
    let row = sqlx::query_as::<_, ProfileRow>(SELECT)
        .bind(user_id)
        .fetch_one(db)
        .await?;
    Ok(row.into())
}

/// GET /v1/profile
pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<impl Serialize>, AppError> {
    Ok(Json(Envelope {
        profile: load(&state.db, user.id).await?,
    }))
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct NotificationsPatch {
    pub follow_ups: Option<bool>,
    pub interview_prep: Option<bool>,
    pub product_news: Option<bool>,
}

/// Every field optional; only those present change. Send an empty string to
/// clear a text field.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfilePatch {
    pub full_name: Option<String>,
    pub headline: Option<String>,
    pub location: Option<String>,
    pub target_roles: Option<Vec<String>>,
    pub work_settings: Option<Vec<String>>,
    pub paper_size: Option<String>,
    pub theme: Option<String>,
    pub notifications: Option<NotificationsPatch>,
    pub onboarding_step: Option<String>,
}

/// Validated text patch: None = leave alone, Some(None) = clear, Some(Some) = set.
fn text_patch(
    field: &'static str,
    v: &Option<String>,
    max: usize,
) -> Result<Option<Option<String>>, AppError> {
    match v {
        None => Ok(None),
        Some(s) => Ok(Some(validate::optional_text(field, Some(s), max)?)),
    }
}

/// PATCH /v1/profile
pub async fn patch(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<ProfilePatch>,
) -> Result<Json<impl Serialize>, AppError> {
    let full_name = text_patch("full_name", &req.full_name, 120)?;
    let headline = text_patch("headline", &req.headline, 160)?;
    let location = text_patch("location", &req.location, 120)?;

    let target_roles = match &req.target_roles {
        None => None,
        Some(roles) => {
            if roles.len() > MAX_TARGET_ROLES {
                return Err(AppError::validation(
                    "target_roles",
                    format!("Choose at most {MAX_TARGET_ROLES} roles"),
                ));
            }
            let mut out: Vec<String> = Vec::new();
            for r in roles {
                let r = validate::required_text("target_roles", r, 80)?;
                if !out.iter().any(|x| x.eq_ignore_ascii_case(&r)) {
                    out.push(r);
                }
            }
            Some(out)
        }
    };
    let work_settings = match &req.work_settings {
        None => None,
        Some(ws) => {
            let mut out: Vec<String> = Vec::new();
            for w in ws {
                validate::one_of("work_settings", w, WORK_SETTINGS)?;
                if !out.contains(w) {
                    out.push(w.clone());
                }
            }
            Some(out)
        }
    };
    if let Some(p) = &req.paper_size {
        validate::one_of("paper_size", p, PAPER_SIZES)?;
    }
    if let Some(t) = &req.theme {
        validate::one_of("theme", t, THEMES)?;
    }
    if let Some(s) = &req.onboarding_step {
        validate::one_of("onboarding_step", s, ONBOARDING_STEPS)?;
    }
    let n = req.notifications.unwrap_or_default();

    ensure(&state.db, user.id).await?;
    sqlx::query(
        r#"
        update profiles set
            full_name             = case when $2 then $3 else full_name end,
            headline              = case when $4 then $5 else headline end,
            location              = case when $6 then $7 else location end,
            target_roles          = coalesce($8, target_roles),
            work_settings         = coalesce($9, work_settings),
            paper_size            = coalesce($10, paper_size),
            theme                 = coalesce($11, theme),
            notify_follow_ups     = coalesce($12, notify_follow_ups),
            notify_interview_prep = coalesce($13, notify_interview_prep),
            notify_product_news   = coalesce($14, notify_product_news),
            onboarding_step       = coalesce($15, onboarding_step)
        where user_id = $1
        "#,
    )
    .bind(user.id)
    .bind(full_name.is_some())
    .bind(full_name.flatten())
    .bind(headline.is_some())
    .bind(headline.flatten())
    .bind(location.is_some())
    .bind(location.flatten())
    .bind(target_roles)
    .bind(work_settings)
    .bind(&req.paper_size)
    .bind(&req.theme)
    .bind(n.follow_ups)
    .bind(n.interview_prep)
    .bind(n.product_news)
    .bind(&req.onboarding_step)
    .execute(&state.db)
    .await?;

    Ok(Json(Envelope {
        profile: load(&state.db, user.id).await?,
    }))
}
