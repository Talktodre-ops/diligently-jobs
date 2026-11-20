//! The AI layer. Handlers and jobs depend on the `Llm` trait, never on a
//! provider, so tests swap in `FakeLlm` and production uses Anthropic.
//!
//! Every call asks for a JSON object matching a schema (structured outputs)
//! and returns it parsed, together with token usage for the cost ledger.

pub mod anthropic;
pub mod fake;

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

use crate::error::AppError;

/// One structured generation request.
#[derive(Debug, Clone)]
pub struct LlmRequest {
    /// Stable name of the prompt family, e.g. `cv_parse`. Used for the usage
    /// ledger, logs and the fake's canned answers.
    pub task: &'static str,
    pub system: String,
    pub user_text: String,
    /// A PDF to read, base64 encoded, sent as a document block before the text.
    pub pdf_base64: Option<String>,
    /// JSON schema the answer must match. Every object needs
    /// `additionalProperties: false`; length and range keywords are not
    /// supported by the API, so validate those in code.
    pub schema: Value,
    pub max_tokens: u32,
    /// `low`, `medium`, `high`. Lower is cheaper and faster.
    pub effort: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub value: Value,
    /// The model that produced the answer (may be a fallback model).
    pub model: String,
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmError {
    /// No API key configured.
    NotConfigured,
    /// The model declined (safety classifier), including after fallbacks.
    Refused { category: Option<String> },
    /// Ran out of output tokens; the JSON is incomplete.
    Truncated,
    /// The answer did not parse as the requested JSON.
    InvalidOutput(String),
    /// Provider error after retries, or a non-retryable 4xx.
    Upstream(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::NotConfigured => write!(f, "AI is not configured"),
            LlmError::Refused { category } => {
                write!(
                    f,
                    "model declined (category: {})",
                    category.as_deref().unwrap_or("none")
                )
            }
            LlmError::Truncated => write!(f, "model output was cut off at max_tokens"),
            LlmError::InvalidOutput(m) => write!(f, "model output invalid: {m}"),
            LlmError::Upstream(m) => write!(f, "AI provider error: {m}"),
        }
    }
}

impl std::error::Error for LlmError {}

impl From<LlmError> for AppError {
    fn from(e: LlmError) -> Self {
        match e {
            LlmError::NotConfigured => {
                AppError::unavailable("ai_unavailable", "AI features are not available right now.")
            }
            LlmError::Refused { .. } => AppError::unprocessable(
                "ai_declined",
                "The AI could not help with this one. Try rewording or removing sensitive details.",
            ),
            other => {
                tracing::error!(error = %other, "ai call failed");
                AppError::unavailable("ai_failed", "The AI step failed. Try again in a moment.")
            }
        }
    }
}

pub type LlmFuture<'a> = Pin<Box<dyn Future<Output = Result<LlmResponse, LlmError>> + Send + 'a>>;

pub trait Llm: Send + Sync {
    fn complete(&self, req: LlmRequest) -> LlmFuture<'_>;
}

/// Pick the implementation from env: Anthropic when ANTHROPIC_API_KEY is set,
/// otherwise one that answers every call with `NotConfigured`.
pub fn from_env() -> anyhow::Result<std::sync::Arc<dyn Llm>> {
    match anthropic::AnthropicConfig::from_env()? {
        Some(cfg) => {
            tracing::info!(model = %cfg.model, "ai: Anthropic configured");
            Ok(std::sync::Arc::new(anthropic::AnthropicLlm::new(cfg)?))
        }
        None => {
            tracing::warn!("ai: ANTHROPIC_API_KEY not set, AI features are off");
            Ok(std::sync::Arc::new(Unconfigured))
        }
    }
}

pub struct Unconfigured;

impl Llm for Unconfigured {
    fn complete(&self, _req: LlmRequest) -> LlmFuture<'_> {
        Box::pin(async { Err(LlmError::NotConfigured) })
    }
}
