use anyhow::{Context, Result};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

/// Initialize the Postgres connection pool. Neon recommends connecting through
/// its pooler endpoint (host contains `-pooler`); we keep our local pool small
/// because the pooler is doing the real concurrency multiplexing.
pub async fn init_pool(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        // Neon (us-east-1) auto-suspends its compute after a few minutes idle.
        // The first request after a suspend has to wake it, which can take
        // several seconds; a tight 5s acquire timeout turns that normal
        // cold-start into a PoolTimedOut. Wait it out instead of erroring.
        .acquire_timeout(Duration::from_secs(30))
        // Cap connection age but keep idle ones around much longer so we don't
        // pay a fresh TLS handshake to us-east-1 on every burst of activity.
        .idle_timeout(Some(Duration::from_secs(600)))
        .max_lifetime(Some(Duration::from_secs(1800)))
        // Validate a connection before handing it out — a connection the Neon
        // pooler dropped during a suspend is replaced transparently rather than
        // failing the request with a broken-pipe error.
        .test_before_acquire(true)
        .connect(database_url)
        .await
        .context("failed to connect to Postgres — check DATABASE_URL and that Neon is reachable")?;

    // Sanity ping so startup fails loud if creds are wrong, rather than the
    // first request being the one to discover it.
    sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(&pool)
        .await
        .context("Postgres ping failed after connect — credentials or network issue")?;

    Ok(pool)
}

/// Run any pending sqlx migrations in `./migrations`. Idempotent.
pub async fn migrate(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("sqlx migrate failed")?;
    Ok(())
}
