//! The Home screen: what needs the user now, and what happened this week.

use axum::extract::State;
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::extract::Json;
use crate::AppState;

fn title(company: &Option<String>) -> String {
    company
        .clone()
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "this job".into())
}

#[derive(FromRow)]
struct FollowUpDue {
    reminder_id: Uuid,
    application_id: Uuid,
    company: Option<String>,
    role: Option<String>,
    due_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct ReviewPending {
    application_id: Uuid,
    company: Option<String>,
    role: Option<String>,
    pending: i64,
}

#[derive(FromRow)]
struct AppRef {
    application_id: Uuid,
    company: Option<String>,
    role: Option<String>,
}

#[derive(FromRow)]
struct EventRow {
    kind: String,
    payload: Value,
    created_at: DateTime<Utc>,
    application_id: Option<Uuid>,
    company: Option<String>,
    role: Option<String>,
}

/// Human line for a timeline event, or None for events Home does not show.
fn describe(e: &EventRow) -> Option<String> {
    let at = title(&e.company);
    match e.kind.as_str() {
        "pipeline_done" => Some(format!("Tailored your CV for {at}")),
        "applied" => Some(format!("Applied to {at}")),
        "followed_up" => Some(format!("Followed up with {at}")),
        "follow_up_due" => Some(format!("Follow-up drafted for {at}")),
        "stage_changed" => match e.payload.get("to").and_then(Value::as_str) {
            Some("interviewing") => Some(format!("Interviewing at {at}")),
            Some("offer") => Some(format!("Offer from {at}")),
            Some("closed") => Some(format!("Closed {at}")),
            _ => None,
        },
        _ => None,
    }
}

/// GET /v1/home
pub async fn home(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let db = &state.db;
    let uid = user.id;
    let mut cards: Vec<Value> = Vec::new();

    let due = sqlx::query_as::<_, FollowUpDue>(
        r#"
        select r.id as reminder_id, a.id as application_id, a.company, a.role, r.due_at
        from reminders r join applications a on a.id = r.application_id and a.user_id = r.user_id
        where r.user_id = $1 and (r.status = 'sent' or (r.status = 'scheduled' and r.due_at <= now()))
        order by r.due_at
        limit 5
        "#,
    )
    .bind(uid)
    .fetch_all(db)
    .await?;
    for d in due {
        cards.push(json!({
            "type": "follow_up", "application_id": d.application_id, "reminder_id": d.reminder_id,
            "company": d.company, "role": d.role, "due_at": d.due_at,
            "text": format!("Follow up with {}", title(&d.company)),
        }));
    }

    let failed = sqlx::query_as::<_, AppRef>(
        r#"
        select a.id as application_id, a.company, a.role
        from applications a join jobs j on j.id = a.pipeline_job_id and j.user_id = a.user_id
        where a.user_id = $1 and j.status = 'failed'
        order by a.updated_at desc limit 3
        "#,
    )
    .bind(uid)
    .fetch_all(db)
    .await?;
    for a in failed {
        cards.push(json!({
            "type": "retry", "application_id": a.application_id, "company": a.company, "role": a.role,
            "text": format!("Finish tailoring for {}", title(&a.company)),
        }));
    }

    let review = sqlx::query_as::<_, ReviewPending>(
        r#"
        select a.id as application_id, a.company, a.role,
               (select count(*) from tailored_bullets b where b.application_id = a.id and b.user_id = a.user_id and b.status = 'pending')
               + (case when a.tailored_summary is not null and a.summary_status = 'pending' then 1 else 0 end) as pending
        from applications a
        where a.user_id = $1 and a.stage = 'saved'
        order by a.updated_at desc limit 10
        "#,
    )
    .bind(uid)
    .fetch_all(db)
    .await?;
    for r in review.into_iter().filter(|r| r.pending > 0).take(3) {
        let what = if r.pending == 1 {
            "1 rewrite".to_string()
        } else {
            format!("{} rewrites", r.pending)
        };
        cards.push(json!({
            "type": "review", "application_id": r.application_id, "company": r.company, "role": r.role,
            "pending": r.pending, "text": format!("Review {what} for {}", title(&r.company)),
        }));
    }

    let interviewing = sqlx::query_as::<_, AppRef>(
        "select id as application_id, company, role from applications where user_id = $1 and stage = 'interviewing' order by updated_at desc limit 3",
    )
    .bind(uid)
    .fetch_all(db)
    .await?;
    for a in interviewing {
        cards.push(json!({
            "type": "prepare", "application_id": a.application_id, "company": a.company, "role": a.role,
            "text": format!("Prepare for {}", title(&a.company)),
        }));
    }

    let week_ago = Utc::now() - Duration::days(7);
    let events = sqlx::query_as::<_, EventRow>(
        r#"
        select e.kind, e.payload, e.created_at, e.application_id, a.company, a.role
        from events e left join applications a on a.id = e.application_id and a.user_id = e.user_id
        where e.user_id = $1 and e.created_at >= $2
          and e.kind in ('pipeline_done', 'applied', 'followed_up', 'follow_up_due', 'stage_changed')
        order by e.created_at desc limit 50
        "#,
    )
    .bind(uid)
    .bind(week_ago)
    .fetch_all(db)
    .await?;
    let this_week: Vec<Value> = events
        .iter()
        .filter_map(|e| {
            describe(e).map(|text| {
                json!({ "at": e.created_at, "kind": e.kind, "application_id": e.application_id,
                        "company": e.company, "role": e.role, "text": text })
            })
        })
        .take(20)
        .collect();

    let (applied_this_week, active, interviews): (i64, i64, i64) = sqlx::query_as(
        r#"
        select count(*) filter (where submitted_at >= $2),
               count(*) filter (where stage in ('applied', 'interviewing')),
               count(*) filter (where stage = 'interviewing')
        from applications where user_id = $1
        "#,
    )
    .bind(uid)
    .bind(week_ago)
    .fetch_one(db)
    .await?;
    let name = crate::followups::candidate_name(db, uid).await?;
    let first_name = name.split_whitespace().next().map(str::to_string);

    Ok(Json(json!({
        "first_name": first_name,
        "needs_you": cards,
        "this_week": this_week,
        "stats": { "applied_this_week": applied_this_week, "active": active, "interviewing": interviews },
    })))
}
