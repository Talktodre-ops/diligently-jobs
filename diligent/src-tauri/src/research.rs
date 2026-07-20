//! Company research — web search proxy (Phase 3, M1).
//!
//! Uses Tavily (https://tavily.com): returns LLM-ready extracted `content` per
//! result, so no separate page-fetch step is needed. The API key stays out of
//! the frontend bundle by living here in the desktop Rust layer (same pattern
//! as the Deepgram/LLM keys). The frontend invokes `web_search`, then
//! synthesizes the brief client-side via the normal AI provider stack.
//! LinkedIn still can't be fetched (login wall / ToS) — the UI offers a paste
//! box for that. Provider-neutral command name so swapping search backends is
//! a one-file change.

use serde::Serialize;
use serde_json::json;
use std::env;

/// One web result, trimmed to what the synthesizer needs.
#[derive(Serialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    /// LLM-ready extracted content (Tavily `content`).
    pub description: String,
    /// Published date when available (news results).
    pub age: Option<String>,
}

fn get_tavily_api_key() -> Result<String, String> {
    if let Ok(k) = env::var("TAVILY_API_KEY") {
        if !k.trim().is_empty() {
            return Ok(k);
        }
    }
    match option_env!("TAVILY_API_KEY") {
        Some(k) if !k.trim().is_empty() => Ok(k.to_string()),
        _ => Err("TAVILY_API_KEY is not set. Add it to src-tauri/.env (no rebuild needed) or the build environment.".to_string()),
    }
}

/// Query Tavily and return the web results.
///
/// `count` maps to Tavily `max_results` (clamped 1..=20). `topic` is "general"
/// (default) or "news". Uses search_depth=basic (1 credit per query). Errors
/// are returned as strings since the caller is JS.
#[tauri::command]
pub async fn web_search(
    query: String,
    count: Option<u8>,
    topic: Option<String>,
) -> Result<Vec<WebSearchResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let key = get_tavily_api_key()?;
    let max_results = count.unwrap_or(6).clamp(1, 20);
    let topic = match topic.as_deref() {
        Some("news") => "news",
        _ => "general",
    };

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {key}"))
        .json(&json!({
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
            "topic": topic,
        }))
        .send()
        .await
        .map_err(|e| format!("Tavily request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Tavily Search returned {status}: {body}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Tavily response parse failed: {e}"))?;

    let results = json.get("results").and_then(|r| r.as_array());
    let out = match results {
        Some(arr) => arr
            .iter()
            .filter_map(|r| {
                let title = r.get("title")?.as_str()?.to_string();
                let url = r.get("url")?.as_str()?.to_string();
                let description = r
                    .get("content")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string();
                let age = r
                    .get("published_date")
                    .and_then(|a| a.as_str())
                    .map(|s| s.to_string());
                Some(WebSearchResult {
                    title,
                    url,
                    description,
                    age,
                })
            })
            .collect(),
        None => Vec::new(),
    };

    Ok(out)
}
