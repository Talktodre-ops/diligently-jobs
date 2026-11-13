//! In-process job worker.
//!
//! Spawned once at startup from `main.rs`. Polls the jobs table, claims one
//! ready row at a time, dispatches to a kind-specific handler, marks done or
//! failed (with backoff retry).

use std::time::Duration;
use tokio::time::sleep;

use crate::AppState;

/// How often to poll when the queue is empty. With one user, work arrives in
/// short bursts and 1s feels instant without hammering Postgres.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How often due follow-up reminders are checked.
const REMINDER_SWEEP_EVERY: Duration = Duration::from_secs(60);

/// How often running jobs that lost their worker are put back in the queue.
const STUCK_SWEEP_EVERY: Duration = Duration::from_secs(30);

/// Spawn the worker as a background tokio task. Returns immediately.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        if let Err(err) = run(state).await {
            tracing::error!(?err, "job worker exited with error");
        }
    });
}

async fn run(state: AppState) -> anyhow::Result<()> {
    tracing::info!("jobs: worker started");

    let mut last_sweep = std::time::Instant::now() - REMINDER_SWEEP_EVERY;
    let mut last_stuck_sweep = std::time::Instant::now() - STUCK_SWEEP_EVERY;
    loop {
        if last_stuck_sweep.elapsed() >= STUCK_SWEEP_EVERY {
            last_stuck_sweep = std::time::Instant::now();
            match super::recover_stuck(&state.db).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(
                    reset = n,
                    "jobs: re-queued running jobs that lost their worker"
                ),
                Err(err) => tracing::warn!(?err, "jobs: stuck-job sweep failed (continuing)"),
            }
        }
        if last_sweep.elapsed() >= REMINDER_SWEEP_EVERY {
            last_sweep = std::time::Instant::now();
            match crate::followups::sweep(&state).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(sent = n, "reminders: sent"),
                Err(err) => tracing::error!(?err, "reminders: sweep failed"),
            }
        }
        match process_one(&state).await {
            Ok(true) => {} // Loop immediately; there might be more work queued.
            Ok(false) => sleep(IDLE_POLL_INTERVAL).await,
            Err(err) => {
                tracing::error!(?err, "jobs: claim_next errored, backing off 5s");
                sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/// Claim and run at most one ready job. Returns `Ok(false)` when the queue had
/// nothing ready. The worker loop calls this; tests call it directly so job
/// execution is deterministic instead of racing a background task.
pub async fn process_one(state: &AppState) -> Result<bool, sqlx::Error> {
    let Some(job) = super::claim_next(&state.db).await? else {
        return Ok(false);
    };
    let job_id = job.id;
    let kind = job.kind.clone();
    tracing::info!(%job_id, %kind, attempt = job.attempts, "jobs: claimed");

    // Keep the job's heartbeat fresh while the handler runs, so the sweep
    // in another process (or after a restart) can tell live work from lost.
    let beat = {
        let db = state.db.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(super::HEARTBEAT_EVERY);
            tick.tick().await; // claim already stamped it
            loop {
                tick.tick().await;
                if let Err(err) = super::heartbeat(&db, job_id).await {
                    tracing::warn!(%job_id, ?err, "jobs: heartbeat failed");
                }
            }
        })
    };
    let outcome = super::handlers::dispatch(state, &job).await;
    beat.abort();

    match outcome {
        Ok(result) => {
            if let Err(err) = super::mark_done(&state.db, job_id, result).await {
                tracing::error!(%job_id, ?err, "jobs: mark_done failed");
            } else {
                tracing::info!(%job_id, %kind, "jobs: done");
            }
        }
        Err(handler_err) => {
            let msg = format!("{handler_err:#}");
            tracing::warn!(%job_id, %kind, error = %msg, "jobs: handler failed");
            if let Err(err) = super::mark_failed(&state.db, &job, &msg).await {
                tracing::error!(%job_id, ?err, "jobs: mark_failed failed");
            }
        }
    }
    Ok(true)
}
