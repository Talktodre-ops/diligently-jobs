//! The Tavily client against a local mock: auth header, request bodies, and a
//! 200 that carries only failed_results.

use std::sync::{Arc, Mutex};

use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use diligently_api::web::{Tavily, WebError, WebSearch};
use serde_json::{json, Value};

async fn serve(seen: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>) -> String {
    let s1 = seen.clone();
    let s2 = seen.clone();
    let app = Router::new()
        .route(
            "/search",
            post(move |h: HeaderMap, Json(b): Json<Value>| {
                let s = s1.clone();
                async move {
                    s.lock().unwrap().push(("search".into(), h, b));
                    Json(json!({ "results": [{ "title": "Halcyon raises Series B", "url": "https://news.example/h", "content": "Health data startup" }] }))
                }
            }),
        )
        .route(
            "/extract",
            post(move |h: HeaderMap, Json(b): Json<Value>| {
                let s = s2.clone();
                async move {
                    let url = b["urls"][0].as_str().unwrap_or("").to_string();
                    s.lock().unwrap().push(("extract".into(), h, b));
                    if url.contains("blocked") {
                        Json(json!({ "results": [], "failed_results": [{ "url": url, "error": "403" }] }))
                    } else {
                        Json(json!({ "results": [{ "url": url, "raw_content": "Senior Backend Engineer\nRequirements: Go, Postgres" }], "failed_results": [] }))
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn search_and_extract_round_trip() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let base = serve(seen.clone()).await;
    let t = Tavily::new("tvly-test".into(), base).unwrap();

    let hits = t.search("Halcyon Health funding", 5).await.unwrap();
    assert_eq!(hits[0].title, "Halcyon raises Series B");

    let page = t.extract("https://jobs.example/123").await.unwrap();
    assert!(page.content.contains("Requirements"));

    let err = t.extract("https://blocked.example/1").await.unwrap_err();
    assert_eq!(err, WebError::Unreadable("403".into()));

    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].1["authorization"], "Bearer tvly-test");
    assert_eq!(seen[0].2["search_depth"], "basic");
    assert_eq!(seen[1].2["urls"], json!(["https://jobs.example/123"]));
}
