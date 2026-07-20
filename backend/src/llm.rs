//! Minimal OpenAI-compatible chat client for backend LLM jobs (e.g. ATS scoring).
//!
//! Works with any OpenAI-compatible `/chat/completions` endpoint (OpenAI,
//! DeepSeek, etc.). Config from env (read lazily so the rest of the server runs
//! without it; only LLM-backed jobs require it):
//!   LLM_API_KEY   (required for LLM jobs)
//!   LLM_API_BASE  (default https://api.openai.com/v1)
//!   LLM_MODEL     (default gpt-4o-mini)

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

pub struct Llm {
    base: String,
    key: String,
    model: String,
}

impl Llm {
    pub fn from_env() -> Result<Self> {
        let key = std::env::var("LLM_API_KEY")
            .map_err(|_| anyhow!("LLM_API_KEY is not set — required for the ATS scoring job"))?;
        if key.trim().is_empty() {
            return Err(anyhow!("LLM_API_KEY is empty"));
        }
        let base = std::env::var("LLM_API_BASE")
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
        let model = std::env::var("LLM_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            key,
            model,
        })
    }

    /// Send a system + user prompt, request a JSON object back, and return the
    /// raw content string (the caller parses it). Temperature 0 for stable
    /// scores.
    pub async fn chat_json(&self, system: &str, user: &str) -> Result<String> {
        let body = json!({
            "model": self.model,
            "temperature": 0,
            "response_format": { "type": "json_object" },
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat/completions", self.base))
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .context("LLM request failed")?;

        let status = resp.status();
        let text = resp.text().await.context("read LLM response body")?;
        if !status.is_success() {
            return Err(anyhow!("LLM API error {status}: {text}"));
        }

        let parsed: Value = serde_json::from_str(&text).context("LLM response was not JSON")?;
        let content = parsed
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("LLM response missing choices[0].message.content"))?;
        Ok(content.to_string())
    }
}
