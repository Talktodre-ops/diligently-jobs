use anyhow::{Context, Result};
use std::env;
use std::net::SocketAddr;

/// All runtime configuration the server needs. Loaded once at startup; failures
/// here are fatal — better to crash with a clear error than start half-broken.
#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub bearer_token: String,
    pub database_url: String,
    pub r2: R2Config,
}

#[derive(Clone, Debug)]
pub struct R2Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl Config {
    /// Load from environment, respecting `.env` if present.
    pub fn from_env() -> Result<Self> {
        // Best-effort .env load. Missing file is fine in production where env
        // comes from the container runtime; a parse error is logged but not
        // fatal because critical vars may also be set in the OS environment.
        if let Err(err) = dotenvy::dotenv() {
            tracing::warn!(error = %err, ".env not loaded — relying on OS environment for required vars");
        }

        let bind_addr: SocketAddr = required_env("BIND_ADDR")?
            .parse()
            .context("BIND_ADDR is not a valid socket address (expected host:port)")?;

        let bearer_token = required_env("BEARER_TOKEN")?;
        if bearer_token.len() < 32 {
            anyhow::bail!(
                "BEARER_TOKEN is too short ({} chars); use at least 32 hex chars",
                bearer_token.len()
            );
        }

        let database_url = required_env("DATABASE_URL")?;
        if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
            anyhow::bail!("DATABASE_URL must start with postgres:// or postgresql://");
        }

        let r2 = R2Config {
            endpoint: required_env("R2_ENDPOINT")?,
            region: env::var("R2_REGION").unwrap_or_else(|_| "auto".to_string()),
            bucket: required_env("R2_BUCKET")?,
            access_key_id: required_env("R2_ACCESS_KEY_ID")?,
            secret_access_key: required_env("R2_SECRET_ACCESS_KEY")?,
        };

        Ok(Self {
            bind_addr,
            bearer_token,
            database_url,
            r2,
        })
    }
}

fn required_env(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("missing required env var: {key}"))
}
