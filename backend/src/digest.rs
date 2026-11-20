//! The Monday summary and the running-low email.
//!
//! The Monday summary goes out on Monday at the user's send hour in their
//! zone, at most once per local Monday. The sweep claims a user by setting
//! `weekly_summary_sent_on` to that Monday in one conditional update, so two
//! workers never both send; a week with nothing in it keeps the claim and
//! sends nothing, and a failed send puts the previous value back so the next
//! sweep tries again. Unverified users and users who turned it off are never
//! picked.
//!
//! Running low goes out once per (UTC) month when a user on a plan with a
//! monthly limit above 2 starts the application that leaves them 2 or fewer,
//! claimed the same way through `running_low_sent_for`.

use chrono::{DateTime, NaiveDate, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use crate::error::AppError;
use crate::mail::{self, layout::Row};
use crate::notify::{self, Recipient};
use crate::AppState;

/// Most rows listed in one summary; the counts still cover everything.
const MAX_ROWS: usize = 8;

/// Send every Monday summary that is due now. Returns how many went out.
pub async fn weekly_sweep(state: &AppState) -> anyhow::Result<usize> {
    weekly_sweep_at(state, Utc::now()).await
}

/// `weekly_sweep` as if it were `now`, for tests.
pub async fn weekly_sweep_at(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<usize> {
    let due: Vec<(Uuid, NaiveDate)> = sqlx::query_as(
        r#"
        with p as (
            select p.user_id, p.send_hour, p.weekly_summary_sent_on,
                   $1::timestamptz at time zone coalesce(p.time_zone, 'UTC') as local_now
            from profiles p join users u on u.id = p.user_id
            where p.notify_weekly_summary and u.email_verified_at is not null
        )
        select user_id, local_now::date from p
        where extract(isodow from local_now) = 1
          and extract(hour from local_now) >= send_hour
          and (weekly_summary_sent_on is null or weekly_summary_sent_on < local_now::date)
        limit 200
        "#,
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    let mut sent = 0;
    for (user_id, monday) in due {
        match weekly_one(state, user_id, monday, now).await {
            Ok(true) => sent += 1,
            Ok(false) => {}
            Err(e) => tracing::error!(%user_id, error = %e, "weekly summary failed"),
        }
    }
    Ok(sent)
}

#[derive(FromRow)]
struct DueRow {
    company: Option<String>,
    role: Option<String>,
    day_short: String,
    day_long: String,
    is_today: bool,
    drafted: bool,
}

#[derive(FromRow)]
struct AppRow {
    company: Option<String>,
    role: Option<String>,
}

#[derive(FromRow)]
struct QuietRow {
    company: Option<String>,
    days: i64,
    followed_up: bool,
}

fn company(c: &Option<String>) -> String {
    c.clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "this job".into())
}

fn role(r: &Option<String>) -> String {
    r.clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "The role".into())
}

/// Claim, build and send one user's summary. True when an email went out.
async fn weekly_one(
    state: &AppState,
    user_id: Uuid,
    monday: NaiveDate,
    now: DateTime<Utc>,
) -> Result<bool, AppError> {
    let claimed: Option<Option<NaiveDate>> = sqlx::query_scalar(
        r#"
        with old as (select weekly_summary_sent_on as prev from profiles where user_id = $1 for update)
        update profiles p set weekly_summary_sent_on = $2
        from old
        where p.user_id = $1 and p.notify_weekly_summary
          and (old.prev is null or old.prev < $2)
        returning old.prev
        "#,
    )
    .bind(user_id)
    .bind(monday)
    .fetch_optional(&state.db)
    .await?;
    let Some(previous) = claimed else {
        return Ok(false);
    };
    let outcome = async {
        let Some(r) = notify::recipient(&state.db, user_id).await? else {
            return Ok(false);
        };
        if !r.verified {
            return Ok(false);
        }
        let Some(email) = build_weekly(state, user_id, &r, monday, now).await? else {
            return Ok(false);
        };
        state
            .mailer
            .send(email)
            .await
            .map_err(|e| AppError::Internal(e.context("send weekly summary")))?;
        Ok(true)
    }
    .await;
    if outcome.is_err() {
        // Give the week back so the next sweep tries again.
        sqlx::query("update profiles set weekly_summary_sent_on = $2 where user_id = $1")
            .bind(user_id)
            .bind(previous)
            .execute(&state.db)
            .await?;
    }
    outcome
}

/// The summary for one user, or None for a week with nothing in it.
async fn build_weekly(
    state: &AppState,
    user_id: Uuid,
    r: &Recipient,
    monday: NaiveDate,
    now: DateTime<Utc>,
) -> Result<Option<mail::Email>, AppError> {
    let db = &state.db;
    let tz = r.time_zone.clone().unwrap_or_else(|| "UTC".to_string());

    // Reminders due in the next 7 days, including any overdue ones the
    // reminder sweep has not sent yet.
    let due = sqlx::query_as::<_, DueRow>(
        r#"
        select a.company, a.role,
               to_char(r.due_at at time zone $3, 'Dy') as day_short,
               to_char(r.due_at at time zone $3, 'FMDay') as day_long,
               (r.due_at at time zone $3)::date <= $4 as is_today,
               exists(select 1 from follow_ups f where f.application_id = a.id and f.user_id = a.user_id
                      and f.channel = 'email' and f.created_at >= r.created_at) as drafted
        from reminders r join applications a on a.id = r.application_id and a.user_id = r.user_id
        where r.user_id = $1 and r.status in ('scheduled', 'sending')
          and r.due_at < $2::timestamptz + interval '7 days'
        order by r.due_at
        "#,
    )
    .bind(user_id)
    .bind(now)
    .bind(&tz)
    .bind(monday)
    .fetch_all(db)
    .await?;

    // Tailored (the pipeline finished) but not applied to yet.
    let ready = sqlx::query_as::<_, AppRow>(
        r#"
        select a.company, a.role
        from applications a join jobs j on j.id = a.pipeline_job_id and j.user_id = a.user_id
        where a.user_id = $1 and a.stage = 'saved' and j.status = 'done'
        order by a.updated_at desc
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    // Applied 14 or more days ago, still at "applied" with no stage change
    // since, and no reminder waiting (those are listed as due instead).
    let quiet = sqlx::query_as::<_, QuietRow>(
        r#"
        select a.company,
               extract(day from $2::timestamptz - a.submitted_at)::bigint as days,
               exists(select 1 from reminders r where r.application_id = a.id and r.user_id = a.user_id
                      and r.status in ('sent', 'done')) as followed_up
        from applications a
        where a.user_id = $1 and a.stage = 'applied'
          and a.submitted_at <= $2::timestamptz - interval '14 days'
          and not exists (select 1 from events e where e.application_id = a.id and e.user_id = a.user_id
                          and e.kind = 'stage_changed' and e.created_at > a.submitted_at)
          and not exists (select 1 from reminders r where r.application_id = a.id and r.user_id = a.user_id
                          and r.status in ('scheduled', 'sending'))
        order by a.submitted_at
        "#,
    )
    .bind(user_id)
    .bind(now)
    .fetch_all(db)
    .await?;

    if due.is_empty() && ready.is_empty() && quiet.is_empty() {
        return Ok(None);
    }

    let (sent_last_week, week_of): (i64, String) = sqlx::query_as(
        r#"
        select (select count(*) from applications
                where user_id = $1
                  and submitted_at >= (($2::date - 7)::timestamp at time zone $3)
                  and submitted_at < ($2::date::timestamp at time zone $3)),
               to_char($2::date, 'FMDD FMMonth')
        "#,
    )
    .bind(user_id)
    .bind(monday)
    .bind(&tz)
    .fetch_one(db)
    .await?;

    let preview = if let Some(d) = due.first() {
        if d.is_today {
            format!("{} is due today.", company(&d.company))
        } else {
            format!("{} is due on {}.", company(&d.company), d.day_long)
        }
    } else if let Some(a) = ready.first() {
        format!(
            "Your {} application is ready to download.",
            company(&a.company)
        )
    } else {
        let q = &quiet[0];
        format!(
            "{} has been quiet for {} days.",
            company(&q.company),
            q.days
        )
    };

    let mut rows: Vec<Row> = Vec::new();
    for d in &due {
        rows.push(Row {
            label: if d.is_today {
                "Today".into()
            } else {
                d.day_short.clone()
            },
            title: format!("Follow up with {}", company(&d.company)),
            detail: if d.drafted {
                format!("{}. Draft ready.", role(&d.role))
            } else {
                format!("{}.", role(&d.role))
            },
            accent: true,
        });
    }
    for a in &ready {
        rows.push(Row {
            label: "Any day".into(),
            title: format!("Apply to {}", company(&a.company)),
            detail: format!("{}. Tailored and ready to download.", role(&a.role)),
            accent: true,
        });
    }
    for q in &quiet {
        rows.push(Row {
            label: "Quiet".into(),
            title: format!("{}, {} days, no reply", company(&q.company), q.days),
            detail: if q.followed_up {
                "Already followed up once. Worth closing it to keep your list honest.".into()
            } else {
                "No follow-up yet. A short note could still help, or close it to keep your list honest.".into()
            },
            accent: false,
        });
    }
    rows.truncate(MAX_ROWS);

    let app = &state.config.web.app_base_url;
    let send_time = notify::send_time(r.send_hour);
    Ok(Some(mail::weekly_summary(
        &r.email,
        mail::Weekly {
            week_of: &week_of,
            due: due.len() as i64,
            ready: ready.len() as i64,
            quiet: quiet.len() as i64,
            sent_last_week,
            rows,
            preview,
            app,
            send_time: &send_time,
        },
        mail::unsubscribe(
            app,
            &r.unsubscribe_token,
            "weekly_summary",
            "",
            "Stop Monday summaries",
        ),
        format!("weekly-{user_id}-{monday}"),
    )))
}

/// After an application starts: send the running-low email if this one left
/// the user with 2 or fewer for the month. Best effort; never fails the start.
pub async fn after_application_started(state: &AppState, user_id: Uuid, plan: &str) {
    if let Err(e) = running_low(state, user_id, plan).await {
        tracing::error!(%user_id, error = %e, "running-low check failed");
    }
}

async fn running_low(state: &AppState, user_id: Uuid, plan: &str) -> Result<(), AppError> {
    let limit = state.config.limits.monthly_limit(plan);
    if limit <= 2 {
        return Ok(());
    }
    let used = crate::usage::applications_this_month(&state.db, user_id).await?;
    let left = limit - used;
    if !(1..=2).contains(&left) {
        return Ok(());
    }
    let (month_start, next_month) = crate::usage::month_bounds(Utc::now());
    let month = month_start.date_naive();
    let claimed: Option<Option<NaiveDate>> = sqlx::query_scalar(
        r#"
        with old as (select running_low_sent_for as prev from profiles where user_id = $1 for update)
        update profiles p set running_low_sent_for = $2
        from old
        where p.user_id = $1 and p.notify_running_low
          and old.prev is distinct from $2
          and exists (select 1 from users u where u.id = $1 and u.email_verified_at is not null)
        returning old.prev
        "#,
    )
    .bind(user_id)
    .bind(month)
    .fetch_optional(&state.db)
    .await?;
    let Some(previous) = claimed else {
        return Ok(());
    };
    let Some(r) = notify::recipient(&state.db, user_id).await? else {
        return Ok(());
    };
    let app = &state.config.web.app_base_url;
    let resets_on = next_month.format("%-d %B").to_string();
    let email = mail::running_low(
        &r.email,
        &mail::RunningLow {
            used,
            limit,
            resets_on: &resets_on,
            app,
        },
        mail::unsubscribe(
            app,
            &r.unsubscribe_token,
            "running_low",
            "",
            "Stop these emails",
        ),
        format!("runninglow-{user_id}-{month}"),
    );
    if let Err(e) = state.mailer.send(email).await {
        sqlx::query("update profiles set running_low_sent_for = $2 where user_id = $1")
            .bind(user_id)
            .bind(previous)
            .execute(&state.db)
            .await?;
        return Err(AppError::Internal(e.context("send running-low email")));
    }
    Ok(())
}
