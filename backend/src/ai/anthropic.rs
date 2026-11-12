//! Claude via the Messages API over HTTPS (no official Rust SDK exists).
//!
//! Request shape: POST {base}/v1/messages with `x-api-key` and
//! `anthropic-version: 2026-10-21`. The answer is constrained with
//! `output_config.format` (`json_schema`). Thinking is left at the model's
//! adaptive default; depth is set with `output_config.effort`. Server-side
//! refusal fallbacks (`fallbacks: "default"`, beta
//! `server-side-fallback-2026-07-01`) are on for models that support them,
//! so a classifier decline is retried on another model inside the same call.
//!
//! Retries: 429, 500, 502, 503, 504, 529 and connection errors, honouring
//! `retry-after`, otherwise exponential backoff with jitter, bounded.

use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};

use super::{Llm, LlmError, LlmFuture, LlmRequest, LlmResponse, Usage};

pub const API_VERSION: &str = "2026-10-21";
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const MAX_ATTEMPTS: u32 = 4;
const BACKOFF_CAP: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    /// Request server-side refusal fallbacks.
    pub fallbacks: bool,
    pub timeout: Duration,
}

/// Models that accept `fallbacks: "default"`. Haiku has no server-side
/// fallback; sending the parameter there is pointless or an error.
fn supports_default_fallbacks(model: &str) -> bool {
    [
        "claude-opus-5",
        "claude-sonnet-5-5",
        "claude-fable-5",
        "claude-mythos-5",
    ]
    .iter()
    .any(|p| model.starts_with(p))
}

impl AnthropicConfig {
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let key = match std::env::var("ANTHROPIC_API_KEY") {
            Ok(k) if !k.trim().is_empty() => k.trim().to_string(),
            _ => return Ok(None),
        };
        let model = std::env::var("ANTHROPIC_MODEL")
            .ok()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string())
            .trim_end_matches('/')
            .to_string();
        let fallbacks = supports_default_fallbacks(&model);
        Ok(Some(Self {
            api_key: key,
            model,
            base_url,
            fallbacks,
            timeout: Duration::from_secs(180),
        }))
    }
}

pub struct AnthropicLlm {
    cfg: AnthropicConfig,
    http: reqwest::Client,
}

impl AnthropicLlm {
    pub fn new(cfg: AnthropicConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(cfg.timeout)
            .build()
            .context("build anthropic http client")?;
        Ok(Self { cfg, http })
    }
}

/// The JSON body for one request. Pure, so it can be unit tested.
pub fn build_body(req: &LlmRequest, model: &str, fallbacks: bool) -> Value {
    let mut content = Vec::new();
    if let Some(pdf) = &req.pdf_base64 {
        content.push(json!({
            "type": "document",
            "source": { "type": "base64", "media_type": "application/pdf", "data": pdf }
        }));
    }
    content.push(json!({ "type": "text", "text": req.user_text }));
    let mut body = json!({
        "model": model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "messages": [{ "role": "user", "content": content }],
        "output_config": {
            "effort": req.effort,
            "format": { "type": "json_schema", "schema": req.schema }
        }
    });
    if fallbacks {
        body["fallbacks"] = json!("default");
    }
    body
}

/// Turn a 200 response body into a parsed answer or a typed error.
pub fn parse_response(body: &Value) -> Result<LlmResponse, LlmError> {
    let stop = body
        .get("stop_reason")
        .and_then(Value::as_str)
        .unwrap_or("");
    if stop == "refusal" {
        let category = body
            .pointer("/stop_details/category")
            .and_then(Value::as_str)
            .map(str::to_string);
        return Err(LlmError::Refused { category });
    }
    if stop == "max_tokens" {
        return Err(LlmError::Truncated);
    }
    let text: String = body
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(LlmError::InvalidOutput("no text content".into()));
    }
    let value: Value = serde_json::from_str(text.trim())
        .map_err(|e| LlmError::InvalidOutput(format!("not JSON: {e}")))?;
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(LlmResponse {
        value,
        model,
        usage: usage_of(body),
    })
}

/// Billable usage. With fallbacks, `usage.iterations` lists every attempt
/// (a declined attempt may still be billed); top-level `usage` covers only
/// the attempt that answered. Sum the iterations when present.
fn usage_of(body: &Value) -> Usage {
    let read = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    let one = |u: &Value| Usage {
        input_tokens: read(u, "input_tokens"),
        output_tokens: read(u, "output_tokens"),
        cache_read_input_tokens: read(u, "cache_read_input_tokens"),
        cache_creation_input_tokens: read(u, "cache_creation_input_tokens"),
    };
    let Some(u) = body.get("usage") else {
        return Usage::default();
    };
    match u.get("iterations").and_then(Value::as_array) {
        Some(its) if !its.is_empty() => its.iter().fold(Usage::default(), |acc, it| {
            let x = one(it);
            Usage {
                input_tokens: acc.input_tokens + x.input_tokens,
                output_tokens: acc.output_tokens + x.output_tokens,
                cache_read_input_tokens: acc.cache_read_input_tokens + x.cache_read_input_tokens,
                cache_creation_input_tokens: acc.cache_creation_input_tokens
                    + x.cache_creation_input_tokens,
            }
        }),
        _ => one(u),
    }
}

pub fn is_retryable(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504 | 529)
}

/// Delay before attempt `attempt + 1`: the server's retry-after when given,
/// else 1s, 2s, 4s... capped, plus up to 25% jitter so callers spread out.
pub fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    if let Some(ra) = retry_after {
        return ra.min(BACKOFF_CAP * 3);
    }
    let base = Duration::from_secs(1u64 << attempt.min(5)).min(BACKOFF_CAP);
    let jitter_ms = (rand::random::<u32>() % 250) as u64 * base.as_millis() as u64 / 1000;
    base + Duration::from_millis(jitter_ms)
}

impl Llm for AnthropicLlm {
    fn complete(&self, req: LlmRequest) -> LlmFuture<'_> {
        Box::pin(async move {
            let body = build_body(&req, &self.cfg.model, self.cfg.fallbacks);
            let url = format!("{}/v1/messages", self.cfg.base_url);
            let mut last_err = String::new();
            for attempt in 0..MAX_ATTEMPTS {
                let mut rb = self
                    .http
                    .post(&url)
                    .header("x-api-key", &self.cfg.api_key)
                    .header("anthropic-version", API_VERSION)
                    .json(&body);
                if self.cfg.fallbacks {
                    rb = rb.header("anthropic-beta", FALLBACK_BETA);
                }
                let started = std::time::Instant::now();
                match rb.send().await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let retry_after = resp
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.trim().parse::<u64>().ok())
                            .map(Duration::from_secs);
                        let text = resp.text().await.unwrap_or_default();
                        if status == 200 {
                            let json: Value = serde_json::from_str(&text).map_err(|e| {
                                LlmError::Upstream(format!("response was not JSON: {e}"))
                            })?;
                            let out = parse_response(&json);
                            let served_by = json.get("model").and_then(Value::as_str).unwrap_or("");
                            tracing::info!(
                                task = req.task,
                                model = served_by,
                                ms = started.elapsed().as_millis() as u64,
                                ok = out.is_ok(),
                                "ai call"
                            );
                            return out;
                        }
                        // The error body names the problem and never echoes our key.
                        last_err =
                            format!("{status}: {}", text.chars().take(400).collect::<String>());
                        if !is_retryable(status) {
                            return Err(LlmError::Upstream(last_err));
                        }
                        tracing::warn!(task = req.task, status, attempt, "ai call retrying");
                        if attempt + 1 < MAX_ATTEMPTS {
                            tokio::time::sleep(backoff(attempt, retry_after)).await;
                        }
                    }
                    Err(e) => {
                        last_err = format!("request failed: {e}");
                        tracing::warn!(task = req.task, attempt, error = %e, "ai call retrying");
                        if attempt + 1 < MAX_ATTEMPTS {
                            tokio::time::sleep(backoff(attempt, None)).await;
                        }
                    }
                }
            }
            Err(LlmError::Upstream(format!(
                "gave up after {MAX_ATTEMPTS} attempts, last {last_err}"
            )))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> LlmRequest {
        LlmRequest {
            task: "t",
            system: "sys".into(),
            user_text: "hello".into(),
            pdf_base64: Some("JVBERi0=".into()),
            schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
            max_tokens: 1000,
            effort: "low",
        }
    }

    #[test]
    fn body_puts_pdf_before_text_and_asks_for_json() {
        let b = build_body(&req(), "claude-sonnet-5-5", true);
        let content = b["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "document");
        assert_eq!(content[0]["source"]["media_type"], "application/pdf");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert_eq!(b["output_config"]["effort"], "low");
        assert_eq!(b["fallbacks"], "default");
        assert!(
            b.get("thinking").is_none(),
            "thinking left at the adaptive default"
        );
        assert!(
            b.get("temperature").is_none(),
            "sampling params are rejected on this API version"
        );
        let nofb = build_body(&req(), "claude-haiku-5-5", false);
        assert!(nofb.get("fallbacks").is_none());
    }

    #[test]
    fn fallback_support_by_model() {
        assert!(supports_default_fallbacks("claude-opus-5-5"));
        assert!(supports_default_fallbacks("claude-sonnet-5-5"));
        assert!(!supports_default_fallbacks("claude-haiku-5-5"));
    }

    #[test]
    fn parses_text_ignoring_thinking_and_fallback_blocks() {
        let body = json!({
            "model": "claude-sonnet-5-5",
            "stop_reason": "end_turn",
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": "{\"score\": 81}" }
            ],
            "usage": { "input_tokens": 120, "output_tokens": 30 }
        });
        let r = parse_response(&body).unwrap();
        assert_eq!(r.value["score"], 81);
        assert_eq!(r.usage.input_tokens, 120);
        assert_eq!(r.model, "claude-sonnet-5-5");
    }

    #[test]
    fn refusal_truncation_and_garbage_are_typed_errors() {
        let refused = json!({ "stop_reason": "refusal", "stop_details": { "category": "cyber" }, "content": [] });
        assert_eq!(
            parse_response(&refused).unwrap_err(),
            LlmError::Refused {
                category: Some("cyber".into())
            }
        );
        let cut = json!({ "stop_reason": "max_tokens", "content": [{"type": "text", "text": "{\"a\":"}] });
        assert_eq!(parse_response(&cut).unwrap_err(), LlmError::Truncated);
        let junk =
            json!({ "stop_reason": "end_turn", "content": [{"type": "text", "text": "sure!"}] });
        assert!(matches!(
            parse_response(&junk).unwrap_err(),
            LlmError::InvalidOutput(_)
        ));
    }

    #[test]
    fn usage_sums_fallback_iterations() {
        let body = json!({
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "{}"}],
            "usage": { "input_tokens": 50, "output_tokens": 10,
                       "iterations": [ { "type": "message", "input_tokens": 40, "output_tokens": 0 },
                                       { "type": "fallback_message", "input_tokens": 50, "output_tokens": 10 } ] }
        });
        let u = parse_response(&body).unwrap().usage;
        assert_eq!((u.input_tokens, u.output_tokens), (90, 10));
    }

    #[test]
    fn backoff_honours_retry_after_and_grows() {
        assert_eq!(
            backoff(0, Some(Duration::from_secs(7))),
            Duration::from_secs(7)
        );
        assert!(backoff(0, None) >= Duration::from_secs(1));
        assert!(backoff(3, None) >= Duration::from_secs(8));
        assert!(backoff(10, None) <= BACKOFF_CAP + BACKOFF_CAP / 4);
        assert!(is_retryable(529) && is_retryable(429) && !is_retryable(400));
    }
}
