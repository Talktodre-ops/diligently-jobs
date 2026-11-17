//! The signed-in user's profile and preferences (Onboarding, Profile and
//! Settings screens). A profile row is created on first read with defaults.

use axum::extract::State;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
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
const ONBOARDING_STEPS: &[&str] = &["upload", "check", "targets", "first_job", "done"];
const MAX_TARGET_ROLES: usize = 10;
pub const FOLLOW_UP_DAYS: &[i32] = &[5, 7, 10, 14];
pub const SEND_HOURS: &[i32] = &[9, 13, 18];
pub const SPELLINGS: &[&str] = &["en-GB", "en-US"];
const MAX_OPEN_TO: usize = 10;

#[derive(Debug, FromRow)]
struct ProfileRow {
    full_name: Option<String>,
    headline: Option<String>,
    location: Option<String>,
    target_roles: Vec<String>,
    work_settings: Vec<String>,
    open_to: Option<Vec<String>>,
    paper_size: String,
    theme: String,
    notify_follow_ups: bool,
    notify_weekly_summary: bool,
    notify_running_low: bool,
    notify_product_news: bool,
    follow_up_days: i32,
    send_hour: i32,
    time_zone: Option<String>,
    skip_weekends: bool,
    spelling: Option<String>,
    letter_tone: String,
    onboarding_step: String,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct Notifications {
    pub follow_ups: bool,
    pub weekly_summary: bool,
    pub running_low: bool,
    pub product_news: bool,
}

#[derive(Debug, Serialize)]
pub struct Reminders {
    pub follow_up_days: i32,
    pub send_hour: i32,
    /// IANA zone name; null until the browser reports one (UTC is used).
    pub time_zone: Option<String>,
    pub skip_weekends: bool,
}

#[derive(Debug, Serialize)]
pub struct Writing {
    /// `en-GB` or `en-US`; null means inferred from location when needed.
    pub spelling: Option<String>,
    pub letter_tone: String,
}

#[derive(Debug, Serialize)]
pub struct ProfileOut {
    pub full_name: Option<String>,
    pub headline: Option<String>,
    pub location: Option<String>,
    pub target_roles: Vec<String>,
    pub work_settings: Vec<String>,
    /// Places the user can work besides `location`. Null until answered.
    pub open_to: Option<Vec<String>>,
    pub paper_size: String,
    pub theme: String,
    pub notifications: Notifications,
    pub reminders: Reminders,
    pub writing: Writing,
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
            open_to: r.open_to,
            paper_size: r.paper_size,
            theme: r.theme,
            notifications: Notifications {
                follow_ups: r.notify_follow_ups,
                weekly_summary: r.notify_weekly_summary,
                running_low: r.notify_running_low,
                product_news: r.notify_product_news,
            },
            reminders: Reminders {
                follow_up_days: r.follow_up_days,
                send_hour: r.send_hour,
                time_zone: r.time_zone,
                skip_weekends: r.skip_weekends,
            },
            writing: Writing {
                spelling: r.spelling,
                letter_tone: r.letter_tone,
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
    select full_name, headline, location, target_roles, work_settings, open_to, paper_size, theme,
           notify_follow_ups, notify_weekly_summary, notify_running_low, notify_product_news,
           follow_up_days, send_hour, time_zone, skip_weekends, spelling, letter_tone,
           onboarding_step, updated_at
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
    pub weekly_summary: Option<bool>,
    pub running_low: Option<bool>,
    pub product_news: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RemindersPatch {
    pub follow_up_days: Option<i32>,
    pub send_hour: Option<i32>,
    /// Absent leaves it alone; null clears it.
    #[serde(default, deserialize_with = "present")]
    pub time_zone: Option<Value>,
    pub skip_weekends: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct WritingPatch {
    /// Absent leaves it alone; null goes back to inferring from location.
    #[serde(default, deserialize_with = "present")]
    pub spelling: Option<Value>,
    pub letter_tone: Option<String>,
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
    pub reminders: Option<RemindersPatch>,
    pub writing: Option<WritingPatch>,
    pub onboarding_step: Option<String>,
    /// Absent leaves it alone; null or an empty list clears it.
    #[serde(default, deserialize_with = "present")]
    pub open_to: Option<Value>,
}

/// Tell "sent as null" (Some(Value::Null)) apart from "not sent" (None).
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// Validated `open_to`: None = leave alone, Some(None) = clear, Some(Some) = set.
fn open_to_patch(v: &Option<Value>) -> Result<Option<Option<Vec<String>>>, AppError> {
    let bad = || {
        AppError::validation(
            "open_to",
            format!("open_to must be a list of up to {MAX_OPEN_TO} places"),
        )
    };
    let items = match v {
        None => return Ok(None),
        Some(Value::Null) => return Ok(Some(None)),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(bad()),
    };
    if items.len() > MAX_OPEN_TO {
        return Err(bad());
    }
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let s = item.as_str().ok_or_else(bad)?;
        let s = validate::required_text("open_to", s, 80)?;
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    }
    Ok(Some(if out.is_empty() { None } else { Some(out) }))
}

/// A nullable string field: None = leave alone, Some(None) = clear,
/// Some(Some) = set. Anything other than a string or null is refused.
fn nullable_string(
    field: &'static str,
    v: &Option<Value>,
) -> Result<Option<Option<String>>, AppError> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.trim().to_string()))),
        Some(_) => Err(AppError::validation(
            field,
            format!("{field} must be a string or null"),
        )),
    }
}

/// A time zone the database knows by its IANA name.
async fn check_time_zone(db: &PgPool, tz: &str) -> Result<(), AppError> {
    let bad = || AppError::validation("time_zone", "Choose a time zone from the list.");
    if tz.is_empty() || tz.len() > 64 {
        return Err(bad());
    }
    let known: bool =
        sqlx::query_scalar("select exists(select 1 from pg_timezone_names where name = $1)")
            .bind(tz)
            .fetch_one(db)
            .await?;
    if known {
        Ok(())
    } else {
        Err(bad())
    }
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
    let open_to = open_to_patch(&req.open_to)?;
    let n = req.notifications.unwrap_or_default();
    let r = req.reminders.unwrap_or_default();
    let w = req.writing.unwrap_or_default();
    if let Some(d) = r.follow_up_days {
        if !FOLLOW_UP_DAYS.contains(&d) {
            return Err(AppError::validation(
                "follow_up_days",
                "follow_up_days must be one of: 5, 7, 10, 14",
            ));
        }
    }
    if let Some(h) = r.send_hour {
        if !SEND_HOURS.contains(&h) {
            return Err(AppError::validation(
                "send_hour",
                "send_hour must be one of: 9, 13, 18",
            ));
        }
    }
    let time_zone = nullable_string("time_zone", &r.time_zone)?;
    if let Some(Some(tz)) = &time_zone {
        check_time_zone(&state.db, tz).await?;
    }
    let spelling = nullable_string("spelling", &w.spelling)?;
    if let Some(Some(sp)) = &spelling {
        validate::one_of("spelling", sp, SPELLINGS)?;
    }
    if let Some(t) = &w.letter_tone {
        validate::one_of("letter_tone", t, crate::prompts::cover_letter::TONES)?;
    }

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
            notify_weekly_summary = coalesce($13, notify_weekly_summary),
            notify_product_news   = coalesce($14, notify_product_news),
            onboarding_step       = coalesce($15, onboarding_step),
            open_to               = case when $16 then $17 else open_to end,
            notify_running_low    = coalesce($18, notify_running_low),
            follow_up_days        = coalesce($19, follow_up_days),
            send_hour             = coalesce($20, send_hour),
            time_zone             = case when $21 then $22 else time_zone end,
            skip_weekends         = coalesce($23, skip_weekends),
            spelling              = case when $24 then $25 else spelling end,
            letter_tone           = coalesce($26, letter_tone)
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
    .bind(n.weekly_summary)
    .bind(n.product_news)
    .bind(&req.onboarding_step)
    .bind(open_to.is_some())
    .bind(open_to.flatten())
    .bind(n.running_low)
    .bind(r.follow_up_days)
    .bind(r.send_hour)
    .bind(time_zone.is_some())
    .bind(time_zone.flatten())
    .bind(r.skip_weekends)
    .bind(spelling.is_some())
    .bind(spelling.flatten())
    .bind(&w.letter_tone)
    .execute(&state.db)
    .await?;

    Ok(Json(Envelope {
        profile: load(&state.db, user.id).await?,
    }))
}

/// `en-US` for the United States and Canada, `en-GB` everywhere else: the
/// rule the web uses to pick Letter paper, read word by word.
pub fn infer_spelling(location: Option<&str>) -> &'static str {
    let lower = location.unwrap_or("").to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let american = words.iter().any(|w| matches!(*w, "usa" | "us" | "canada"))
        || words.windows(2).any(|p| p == ["united", "states"]);
    if american {
        "en-US"
    } else {
        "en-GB"
    }
}

/// What the AI needs to write in the user's voice.
#[derive(Debug, Clone)]
pub struct WritingPrefs {
    /// `en-GB` or `en-US`, stored or inferred.
    pub spelling: &'static str,
    pub letter_tone: String,
}

pub async fn writing_prefs(db: &PgPool, user_id: Uuid) -> Result<WritingPrefs, AppError> {
    let row: Option<(Option<String>, Option<String>, String)> =
        sqlx::query_as("select spelling, location, letter_tone from profiles where user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    let Some((spelling, location, letter_tone)) = row else {
        return Ok(WritingPrefs {
            spelling: "en-GB",
            letter_tone: "direct".to_string(),
        });
    };
    let spelling = match spelling.as_deref() {
        Some("en-US") => "en-US",
        Some("en-GB") => "en-GB",
        _ => infer_spelling(location.as_deref()),
    };
    Ok(WritingPrefs {
        spelling,
        letter_tone,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spelling_follows_the_paper_rule() {
        for us in [
            "Austin, United States",
            "New York, USA",
            "Boston, US",
            "Toronto, Canada",
        ] {
            assert_eq!(infer_spelling(Some(us)), "en-US", "{us}");
        }
        for gb in ["Lagos, Nigeria", "London", "Busan", "Russia", ""] {
            assert_eq!(infer_spelling(Some(gb)), "en-GB", "{gb}");
        }
        assert_eq!(infer_spelling(None), "en-GB");
    }
}
