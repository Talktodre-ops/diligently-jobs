//! Web search and page extraction (Tavily). Company research uses search;
//! "paste a job link" uses extract, so the server never fetches user-supplied
//! URLs itself and cannot be pointed at internal addresses.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Context;
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::AppError;

/// Longest extracted page we pass on. Job pages are far shorter; anything
/// longer is navigation and boilerplate.
pub const MAX_EXTRACT_CHARS: usize = 60_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub published: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub url: String,
    pub content: String,
    /// The page was longer than MAX_EXTRACT_CHARS and was cut.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebError {
    NotConfigured,
    /// The page could not be read (blocked, 404, not a page).
    Unreadable(String),
    Failed(String),
}

impl std::fmt::Display for WebError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WebError::NotConfigured => write!(f, "web search is not configured"),
            WebError::Unreadable(m) => write!(f, "page could not be read: {m}"),
            WebError::Failed(m) => write!(f, "web search failed: {m}"),
        }
    }
}

impl std::error::Error for WebError {}

impl From<WebError> for AppError {
    fn from(e: WebError) -> Self {
        match e {
            WebError::NotConfigured | WebError::Unreadable(_) => AppError::unprocessable(
                "link_unreadable",
                "We could not read that link. Paste the job description text instead.",
            ),
            WebError::Failed(m) => {
                tracing::error!(error = %m, "web search failed");
                AppError::unavailable("web_failed", "Web lookup failed. Try again in a moment.")
            }
        }
    }
}

pub type WebFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, WebError>> + Send + 'a>>;

pub trait WebSearch: Send + Sync {
    fn search(&self, query: &str, max_results: u32) -> WebFuture<'_, Vec<SearchHit>>;
    fn extract(&self, url: &str) -> WebFuture<'_, Extracted>;
}

/// Only http(s) URLs of sane length with a host are sent anywhere.
pub fn check_url(url: &str) -> Result<String, AppError> {
    let u = url.trim();
    let bad = || AppError::validation("url", "Paste a full link starting with https://");
    if u.len() > 2000 || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(bad());
    }
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .ok_or_else(bad)?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || !host.contains('.') {
        return Err(bad());
    }
    Ok(u.to_string())
}

pub fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    match s.char_indices().nth(max) {
        Some((i, _)) => (s[..i].to_string(), true),
        None => (s.to_string(), false),
    }
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

pub struct Tavily {
    http: reqwest::Client,
    key: String,
    base_url: String,
}

impl Tavily {
    pub fn new(key: String, base_url: String) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .context("build tavily client")?;
        Ok(Self {
            http,
            key,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    /// POST with up to three attempts on 429 and 5xx.
    async fn post(&self, path: &str, body: Value) -> Result<Value, WebError> {
        let url = format!("{}{path}", self.base_url);
        let mut last = String::new();
        for attempt in 0..3u32 {
            match self
                .http
                .post(&url)
                .bearer_auth(&self.key)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    if status == 200 {
                        return serde_json::from_str(&text)
                            .map_err(|e| WebError::Failed(format!("response not JSON: {e}")));
                    }
                    last = format!("{status}: {}", text.chars().take(300).collect::<String>());
                    if !(status == 429 || status >= 500) {
                        return Err(WebError::Failed(last));
                    }
                }
                Err(e) => last = format!("request failed: {e}"),
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
            }
        }
        Err(WebError::Failed(last))
    }
}

pub fn parse_search(json: &Value) -> Vec<SearchHit> {
    json.get("results")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    Some(SearchHit {
                        title: r.get("title")?.as_str()?.to_string(),
                        url: r.get("url")?.as_str()?.to_string(),
                        snippet: r
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        published: r
                            .get("published_date")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_extract(json: &Value, url: &str) -> Result<Extracted, WebError> {
    let first = json
        .get("results")
        .and_then(Value::as_array)
        .and_then(|a| a.first());
    match first {
        Some(r) => {
            let raw = r
                .get("raw_content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if raw.is_empty() {
                return Err(WebError::Unreadable("empty page".into()));
            }
            let (content, truncated) = truncate_chars(raw, MAX_EXTRACT_CHARS);
            Ok(Extracted {
                url: r
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or(url)
                    .to_string(),
                content,
                truncated,
            })
        }
        None => {
            let why = json
                .pointer("/failed_results/0/error")
                .and_then(Value::as_str)
                .unwrap_or("no content")
                .to_string();
            Err(WebError::Unreadable(why))
        }
    }
}

impl WebSearch for Tavily {
    fn search(&self, query: &str, max_results: u32) -> WebFuture<'_, Vec<SearchHit>> {
        let body = json!({
            "query": query,
            "max_results": max_results.clamp(1, 10),
            "search_depth": "basic",
            "topic": "general",
        });
        Box::pin(async move { Ok(parse_search(&self.post("/search", body).await?)) })
    }

    fn extract(&self, url: &str) -> WebFuture<'_, Extracted> {
        let url = url.to_string();
        Box::pin(async move {
            let body = json!({ "urls": [url], "extract_depth": "basic", "format": "markdown" });
            parse_extract(&self.post("/extract", body).await?, &url)
        })
    }
}

pub struct Unconfigured;

impl WebSearch for Unconfigured {
    fn search(&self, _q: &str, _n: u32) -> WebFuture<'_, Vec<SearchHit>> {
        Box::pin(async { Err(WebError::NotConfigured) })
    }
    fn extract(&self, _u: &str) -> WebFuture<'_, Extracted> {
        Box::pin(async { Err(WebError::NotConfigured) })
    }
}

/// Tavily when TAVILY_API_KEY is set, otherwise every call is NotConfigured.
pub fn from_env() -> anyhow::Result<std::sync::Arc<dyn WebSearch>> {
    match std::env::var("TAVILY_API_KEY") {
        Ok(k) if !k.trim().is_empty() => {
            let base = std::env::var("TAVILY_BASE_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "https://api.tavily.com".into());
            tracing::info!("web: Tavily configured");
            Ok(std::sync::Arc::new(Tavily::new(
                k.trim().to_string(),
                base,
            )?))
        }
        _ => {
            tracing::warn!("web: TAVILY_API_KEY not set, research and job links are off");
            Ok(std::sync::Arc::new(Unconfigured))
        }
    }
}

// ---------------------------------------------------------------------------
// Fake for tests
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeWeb {
    pages: Mutex<HashMap<String, Result<String, WebError>>>,
    hits: Mutex<Vec<SearchHit>>,
    pub queries: Mutex<Vec<String>>,
}

impl FakeWeb {
    pub fn page(&self, url: &str, content: &str) {
        self.pages
            .lock()
            .expect("fake")
            .insert(url.into(), Ok(content.into()));
    }
    pub fn unreadable(&self, url: &str) {
        self.pages
            .lock()
            .expect("fake")
            .insert(url.into(), Err(WebError::Unreadable("blocked".into())));
    }
    pub fn hits(&self, hits: Vec<SearchHit>) {
        *self.hits.lock().expect("fake") = hits;
    }
}

impl WebSearch for FakeWeb {
    fn search(&self, query: &str, max_results: u32) -> WebFuture<'_, Vec<SearchHit>> {
        self.queries.lock().expect("fake").push(query.to_string());
        let hits: Vec<SearchHit> = self
            .hits
            .lock()
            .expect("fake")
            .iter()
            .take(max_results as usize)
            .cloned()
            .collect();
        Box::pin(async move { Ok(hits) })
    }
    fn extract(&self, url: &str) -> WebFuture<'_, Extracted> {
        let found = self.pages.lock().expect("fake").get(url).cloned();
        let url = url.to_string();
        Box::pin(async move {
            match found {
                Some(Ok(content)) => Ok(Extracted {
                    url,
                    content,
                    truncated: false,
                }),
                Some(Err(e)) => Err(e),
                None => Err(WebError::Unreadable("unknown url".into())),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_check_accepts_web_links_only() {
        assert!(check_url(" https://jobs.example.com/123 ").is_ok());
        for bad in [
            "ftp://x.com",
            "javascript:alert(1)",
            "https://",
            "http://localhost/x",
            "https://a b.com",
            "file:///etc/passwd",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn extract_handles_success_failure_and_truncation() {
        let ok = json!({ "results": [{ "url": "https://x.co/j", "raw_content": "  Senior Engineer  " }], "failed_results": [] });
        let e = parse_extract(&ok, "https://x.co/j").unwrap();
        assert_eq!(e.content, "Senior Engineer");
        assert!(!e.truncated);

        let failed = json!({ "results": [], "failed_results": [{ "url": "https://x.co/j", "error": "403 Forbidden" }] });
        assert_eq!(
            parse_extract(&failed, "u").unwrap_err(),
            WebError::Unreadable("403 Forbidden".into())
        );

        let long = json!({ "results": [{ "url": "u", "raw_content": "é".repeat(MAX_EXTRACT_CHARS + 5) }] });
        let e = parse_extract(&long, "u").unwrap();
        assert!(e.truncated);
        assert_eq!(e.content.chars().count(), MAX_EXTRACT_CHARS);
    }

    #[test]
    fn search_skips_malformed_hits() {
        let j = json!({ "results": [ { "title": "A", "url": "https://a.co", "content": "x" }, { "title": "no url" } ] });
        let hits = parse_search(&j);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "x");
    }
}
