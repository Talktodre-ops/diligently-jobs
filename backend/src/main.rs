use anyhow::Result;
use std::sync::Arc;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use diligently_api::config::Config;
use diligently_api::r2::R2;
use diligently_api::{build_router, db, jobs, render, AppState};

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr;
    tracing::info!(%bind_addr, "starting diligently-api");

    let db = db::init_pool(&config.database_url).await?;
    tracing::info!("postgres pool ready");

    db::migrate(&db).await?;
    tracing::info!("migrations applied");

    let r2 = R2::new(&config.r2).await;
    tracing::info!(bucket = %config.r2.bucket, "r2 client ready");

    // Probe tectonic so misconfigured TECTONIC_BIN surfaces at startup rather
    // than on the first render job. Non-fatal — the worker will retry with
    // exponential backoff and the user sees a clear error in the UI.
    match render::latex::probe_tectonic().await {
        Ok(version) => tracing::info!(%version, "tectonic ready"),
        Err(err) => {
            tracing::warn!(error = %err, "tectonic probe failed — cv_render jobs will fail until this is fixed")
        }
    }

    let state = AppState {
        config: Arc::new(config),
        db,
        r2,
    };

    // Spawn the in-process job worker. It picks up cv_render (and future
    // kinds) so API endpoints can return 202 immediately instead of blocking
    // on slow R2 uploads + Typst/DOCX rendering.
    jobs::worker::spawn(state.clone());

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!(%bind_addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("shut down cleanly");
    Ok(())
}

/// Resolves when the process is asked to stop (Ctrl+C, or SIGTERM on unix) so
/// axum can drain in-flight requests and return normally. Without this, Ctrl+C
/// hard-kills the process and `cargo run` reports a non-zero
/// `STATUS_CONTROL_C_EXIT` ("process didn't exit successfully").
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received — draining");
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("diligently_api=info,tower_http=info,sqlx=error"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .init();
}
