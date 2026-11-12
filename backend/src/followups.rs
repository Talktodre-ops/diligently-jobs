//! Follow-up drafts and the reminder sweep.
//!
//! The sweep claims due reminders with one conditional update under
//! `for update skip locked`, so each reminder is handled by exactly one
//! worker even with several running. A claimed reminder gets a fresh email
//! draft (if none was written since it was scheduled) and, when the user
//! wants reminders, an email whose idempotency key is the reminder id, so a
//! retried send is not delivered twice. Failures go back to the queue an
//! hour later, three attempts at most.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::AppError;
use crate::prompts::follow_up;
use crate::{mail, AppState};

#[derive(Debug, Serialize, FromRow)]
pub struct FollowUpOut {
    pub id: Uuid,
    pub application_id: Uuid,
    pub channel: String,
    pub subject: Option<String>,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

pub const FOLLOW_UP_COLS: &str = "id, application_id, channel, subject, body, created_at";

#[derive(FromRow)]
struct AppCtx {
    role: Option<String>,
    company: Option<String>,
    jd_raw: String,
    submitted_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

/// The name the user signs with: profile name, else the master CV's.
pub async fn candidate_name(db: &PgPool, uid: Uuid) -> Result<String, AppError> {
    let name: Option<String> = sqlx::query_scalar(
        r#"
        select coalesce(nullif(p.full_name, ''), c.sections #>> '{header,name}')
        from profiles p left join cv_versions c on c.id = p.master_cv_version_id and c.user_id = p.user_id
        where p.user_id = $1
        "#,
    )
    .bind(uid)
    .fetch_optional(db)
    .await?
    .flatten();
    Ok(name.unwrap_or_default())
}

/// Write a new follow-up draft for one channel and store it.
pub async fn draft(
    state: &AppState,
    uid: Uuid,
    app_id: Uuid,
    channel: &str,
) -> Result<FollowUpOut, AppError> {
    let ctx = sqlx::query_as::<_, AppCtx>(
        "select role, company, jd_raw, submitted_at, created_at from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let name = candidate_name(&state.db, uid).await?;
    let brief: Option<Value> = sqlx::query_scalar(
        "select brief from company_research where application_id = $1 and user_id = $2 order by created_at desc limit 1",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?;
    let context = format!(
        "{}\n\n{}",
        brief
            .as_ref()
            .map(crate::pipeline::research_text)
            .unwrap_or_default(),
        ctx.jd_raw.chars().take(4_000).collect::<String>()
    );
    let days = (Utc::now() - ctx.submitted_at.unwrap_or(ctx.created_at))
        .num_days()
        .max(0);
    let role = ctx.role.unwrap_or_else(|| "the role".into());
    let company = ctx.company.unwrap_or_else(|| "the company".into());
    let req = follow_up::request(channel, &name, &role, &company, days, &context);
    let res = crate::usage::call(state, uid, Some(app_id), req).await?;
    let d = follow_up::parse(res.value, channel, &name).map_err(|e| {
        tracing::warn!(error = %e, "follow-up rejected");
        AppError::unavailable("ai_failed", "The draft did not come out right. Try again.")
    })?;
    Ok(sqlx::query_as::<_, FollowUpOut>(&format!(
        "insert into follow_ups (user_id, application_id, channel, subject, body) values ($1, $2, $3, $4, $5) returning {FOLLOW_UP_COLS}"
    ))
    .bind(uid)
    .bind(app_id)
    .bind(channel)
    .bind(&d.subject)
    .bind(&d.body)
    .fetch_one(&state.db)
    .await?)
}

#[derive(Debug, FromRow)]
struct Claimed {
    id: Uuid,
    user_id: Uuid,
    application_id: Uuid,
    attempts: i32,
    created_at: DateTime<Utc>,
}

const MAX_ATTEMPTS: i32 = 3;

/// Handle every due reminder once. Returns how many were sent.
pub async fn sweep(state: &AppState) -> anyhow::Result<usize> {
    // A worker that died mid-send leaves rows in 'sending'; give them back.
    sqlx::query(
        "update reminders set status = 'scheduled' where status = 'sending' and updated_at < now() - interval '10 minutes'",
    )
    .execute(&state.db)
    .await?;
    let claimed = sqlx::query_as::<_, Claimed>(
        r#"
        update reminders set status = 'sending', attempts = attempts + 1
        where id in (
            select id from reminders where status = 'scheduled' and due_at <= now()
            order by due_at for update skip locked limit 20
        )
        returning id, user_id, application_id, attempts, created_at
        "#,
    )
    .fetch_all(&state.db)
    .await?;
    let mut sent = 0;
    for r in claimed {
        match deliver(state, &r).await {
            Ok(()) => {
                sqlx::query("update reminders set status = 'sent', sent_at = now() where id = $1 and status = 'sending'")
                    .bind(r.id)
                    .execute(&state.db)
                    .await?;
                crate::routes::tracking::event(
                    &state.db,
                    r.user_id,
                    r.application_id,
                    "follow_up_due",
                    json!({ "reminder_id": r.id }),
                )
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
                sent += 1;
            }
            Err(e) => {
                tracing::warn!(reminder = %r.id, attempt = r.attempts, error = %e, "reminder failed");
                sqlx::query(
                    r#"
                    update reminders set
                        status = case when $2 >= $3 then 'failed' else 'scheduled' end,
                        due_at = now() + interval '1 hour'
                    where id = $1
                    "#,
                )
                .bind(r.id)
                .bind(r.attempts)
                .bind(MAX_ATTEMPTS)
                .execute(&state.db)
                .await?;
            }
        }
    }
    Ok(sent)
}

async fn deliver(state: &AppState, r: &Claimed) -> Result<(), AppError> {
    let existing = sqlx::query_as::<_, FollowUpOut>(&format!(
        "select {FOLLOW_UP_COLS} from follow_ups where application_id = $1 and user_id = $2 and channel = 'email' and created_at >= $3 order by created_at desc limit 1"
    ))
    .bind(r.application_id)
    .bind(r.user_id)
    .bind(r.created_at)
    .fetch_optional(&state.db)
    .await?;
    let d = match existing {
        Some(d) => d,
        None => draft(state, r.user_id, r.application_id, "email").await?,
    };
    #[derive(FromRow)]
    struct Who {
        email: String,
        verified: bool,
        notify: bool,
        company: Option<String>,
        role: Option<String>,
    }
    let who = sqlx::query_as::<_, Who>(
        r#"
        select u.email, u.email_verified_at is not null as verified,
               coalesce(p.notify_follow_ups, true) as notify, a.company, a.role
        from users u join applications a on a.user_id = u.id and a.id = $2
        left join profiles p on p.user_id = u.id
        where u.id = $1
        "#,
    )
    .bind(r.user_id)
    .bind(r.application_id)
    .fetch_one(&state.db)
    .await?;
    if who.verified && who.notify {
        let link = format!(
            "{}/jobs/{}/follow-up",
            state.config.web.app_base_url, r.application_id
        );
        let msg = mail::follow_up_due(
            &who.email,
            who.company.as_deref().unwrap_or("the company"),
            who.role.as_deref().unwrap_or("the role"),
            &link,
            d.subject.as_deref(),
            &d.body,
            format!("reminder-{}", r.id),
        );
        state
            .mailer
            .send(msg)
            .await
            .map_err(|e| AppError::Internal(e.context("send reminder email")))?;
    }
    Ok(())
}
