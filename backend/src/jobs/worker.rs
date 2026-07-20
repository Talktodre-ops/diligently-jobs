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

/// Spawn the worker as a background tokio task. Returns immediately.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        if let Err(err) = run(state).await {
            tracing::error!(?err, "job worker exited with error");
        }
    });
}

async fn run(state: AppState) -> anyhow::Result<()> {
    // Recover stuck jobs from a previous crash.
    match super::recover_stuck(&state.db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(reset = n, "jobs: re-queued stuck 'running' rows from prior boot"),
        Err(err) => tracing::warn!(?err, "jobs: stuck-job recovery failed (continuing)"),
    }

    tracing::info!("jobs: worker started");

    loop {
        match super::claim_next(&state.db).await {
            Ok(Some(job)) => {
                let job_id = job.id;
                let kind = job.kind.clone();
                tracing::info!(%job_id, %kind, attempt = job.attempts, "jobs: claimed");

                match super::handlers::dispatch(&state, &job).await {
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
                // Loop immediately — there might be more work queued.
            }
            Ok(None) => {
                sleep(IDLE_POLL_INTERVAL).await;
            }
            Err(err) => {
                tracing::error!(?err, "jobs: claim_next errored, backing off 5s");
                sleep(Duration::from_secs(5)).await;
            }
        }
    }
}
