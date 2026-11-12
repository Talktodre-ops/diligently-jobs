use anyhow::{Context, Result};
use std::env;
use std::net::SocketAddr;

/// All runtime configuration the server needs. Loaded once at startup; failures
/// here are fatal — better to crash with a clear error than start half-broken.
#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub r2: R2Config,
    pub web: WebConfig,
}

/// Settings for the browser-facing side: where the web app lives, which
/// origins may make state-changing requests, and how session cookies are set.
#[derive(Clone, Debug)]
pub struct WebConfig {
    /// Base URL of the web app, used to build links in emails.
    pub app_base_url: String,
    /// Origins allowed to make unsafe (POST/PATCH/PUT/DELETE) requests with a
    /// session cookie. Defaults to the app base URL.
    pub allowed_origins: Vec<String>,
    /// Set the Secure flag on cookies. True everywhere except plain-HTTP local
    /// development and tests.
    pub cookie_secure: bool,
    /// Read the client IP from exactly one X-Forwarded-For hop. Only enable
    /// behind a proxy you control, or clients can spoof their IP.
    pub trust_proxy: bool,
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

        let app_base_url = env::var("APP_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:5173".to_string())
            .trim_end_matches('/')
            .to_string();
        if !app_base_url.starts_with("http://") && !app_base_url.starts_with("https://") {
            anyhow::bail!("APP_BASE_URL must start with http:// or https://");
        }
        let allowed_origins = match env::var("ALLOWED_ORIGINS") {
            Ok(v) if !v.trim().is_empty() => v
                .split(',')
                .map(|o| o.trim().trim_end_matches('/').to_string())
                .filter(|o| !o.is_empty())
                .collect(),
            _ => vec![app_base_url.clone()],
        };
        let web = WebConfig {
            app_base_url,
            allowed_origins,
            cookie_secure: env_bool("COOKIE_SECURE", true)?,
            trust_proxy: env_bool("TRUST_PROXY", false)?,
        };

        Ok(Self {
            bind_addr,
            database_url,
            r2,
            web,
        })
    }
}

fn env_bool(key: &str, default: bool) -> Result<bool> {
    match env::var(key) {
        Err(_) => Ok(default),
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "" => Ok(default),
            "1" | "true" | "yes" => Ok(true),
            "0" | "false" | "no" => Ok(false),
            other => anyhow::bail!("{key} must be true or false, got `{other}`"),
        },
    }
}

fn required_env(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("missing required env var: {key}"))
}
