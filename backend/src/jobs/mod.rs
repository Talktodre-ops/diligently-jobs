//! Async jobs subsystem.
//!
//! API handlers enqueue rows into `jobs` and return immediately with a job id.
//! The worker (see `worker.rs`) polls the table, claims one row at a time
//! using `for update skip locked`, dispatches to a handler in `handlers.rs`,
//! and marks the row done/failed.
//!
//! Single-process design — fits the single-user backend deployment. To scale
//! to multiple workers later, just spawn the loop more than once; the
//! `skip locked` claim makes that safe.

pub mod handlers;
pub mod worker;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::error::AppError;

/// Stuck-job recovery window. Anything in `running` longer than this on boot
/// gets reset to `queued` so a previous crash doesn't strand work.
pub const STUCK_RUNNING_AFTER: ChronoDuration = ChronoDuration::minutes(5);

#[derive(Debug, Serialize, FromRow)]
pub struct Job {
    pub id: Uuid,
    pub kind: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub result: Option<serde_json::Value>,
    pub attempts: i32,
    pub max_attempts: i32,
    pub last_error: Option<String>,
    pub scheduled_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Enqueue a job. Returns the persisted row so the caller can hand the id to
/// the client for status polling.
pub async fn enqueue(
    pool: &PgPool,
    kind: &str,
    payload: serde_json::Value,
    max_attempts: i32,
) -> Result<Job, AppError> {
    let job = sqlx::query_as::<_, Job>(
        r#"
        insert into jobs (kind, payload, max_attempts)
        values ($1, $2, $3)
        returning
            id, kind, payload, status, result, attempts, max_attempts,
            last_error, scheduled_at, started_at, completed_at, created_at, updated_at
        "#,
    )
    .bind(kind)
    .bind(&payload)
    .bind(max_attempts)
    .fetch_one(pool)
    .await?;
    Ok(job)
}

pub async fn get_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Job>, AppError> {
    let job = sqlx::query_as::<_, Job>(
        r#"
        select
            id, kind, payload, status, result, attempts, max_attempts,
            last_error, scheduled_at, started_at, completed_at, created_at, updated_at
        from jobs
        where id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(job)
}

/// Atomically claim the next runnable job.
///
/// Uses `for update skip locked` so multiple workers (or future ones) never
/// double-claim the same row. Returns `None` when nothing is ready.
pub async fn claim_next(pool: &PgPool) -> Result<Option<Job>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let candidate: Option<Job> = sqlx::query_as::<_, Job>(
        r#"
        select
            id, kind, payload, status, result, attempts, max_attempts,
            last_error, scheduled_at, started_at, completed_at, created_at, updated_at
        from jobs
        where status = 'queued' and scheduled_at <= now()
        order by scheduled_at asc
        for update skip locked
        limit 1
        "#,
    )
    .fetch_optional(&mut *tx)
    .await?;

    let Some(mut job) = candidate else {
        tx.commit().await?;
        return Ok(None);
    };

    let updated = sqlx::query_as::<_, Job>(
        r#"
        update jobs
        set status = 'running',
            attempts = attempts + 1,
            started_at = coalesce(started_at, now())
        where id = $1
        returning
            id, kind, payload, status, result, attempts, max_attempts,
            last_error, scheduled_at, started_at, completed_at, created_at, updated_at
        "#,
    )
    .bind(job.id)
    .fetch_one(&mut *tx)
    .await?;
    job = updated;

    tx.commit().await?;
    Ok(Some(job))
}

pub async fn mark_done(
    pool: &PgPool,
    id: Uuid,
    result: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        update jobs
        set status = 'done',
            result = $2,
            completed_at = now(),
            last_error = null
        where id = $1
        "#,
    )
    .bind(id)
    .bind(&result)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark a job failed. If retryable (attempts < max_attempts) the row is
/// re-queued with exponential backoff (2^attempts seconds, capped at 5 min).
/// Otherwise the row is terminal `failed`.
pub async fn mark_failed(pool: &PgPool, job: &Job, error: &str) -> Result<(), sqlx::Error> {
    if job.attempts < job.max_attempts {
        let backoff_secs = (1_u64 << job.attempts.min(8) as u32).min(300);
        let backoff = ChronoDuration::seconds(backoff_secs as i64);
        sqlx::query(
            r#"
            update jobs
            set status = 'queued',
                last_error = $2,
                scheduled_at = now() + $3::interval
            where id = $1
            "#,
        )
        .bind(job.id)
        .bind(error)
        .bind(format!("{} seconds", backoff.num_seconds()))
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            update jobs
            set status = 'failed',
                last_error = $2,
                completed_at = now()
            where id = $1
            "#,
        )
        .bind(job.id)
        .bind(error)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// On boot: any row stuck in 'running' for > STUCK_RUNNING_AFTER must be from a
/// previous crash. Reset to 'queued' so the worker picks them up.
pub async fn recover_stuck(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        r#"
        update jobs
        set status = 'queued',
            scheduled_at = now()
        where status = 'running'
          and started_at < now() - $1::interval
        "#,
    )
    .bind(format!("{} seconds", STUCK_RUNNING_AFTER.num_seconds()))
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Idempotency helper for callers that don't want to enqueue a duplicate.
/// Returns Some(existing) if a job of the same kind with a payload that JSON-equals
/// `payload_match` is already queued or running.
pub async fn find_active(
    pool: &PgPool,
    kind: &str,
    payload_match: &serde_json::Value,
) -> Result<Option<Job>, sqlx::Error> {
    sqlx::query_as::<_, Job>(
        r#"
        select
            id, kind, payload, status, result, attempts, max_attempts,
            last_error, scheduled_at, started_at, completed_at, created_at, updated_at
        from jobs
        where kind = $1
          and status in ('queued', 'running')
          and payload @> $2
        order by created_at desc
        limit 1
        "#,
    )
    .bind(kind)
    .bind(payload_match)
    .fetch_optional(pool)
    .await
}
