//! The Anthropic client against a local mock of the Messages endpoint:
//! headers, retry on overload, no retry on a client error.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use diligently_api::ai::anthropic::{AnthropicConfig, AnthropicLlm};
use diligently_api::ai::{Llm, LlmError, LlmRequest};
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Mock {
    calls: Arc<AtomicUsize>,
    /// Status to return for each call in order; afterwards 200.
    script: Arc<Mutex<Vec<u16>>>,
    seen: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}

async fn serve(mock: Mock) -> String {
    let m = mock.clone();
    let app = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap, body: axum::Json<Value>| {
            let m = m.clone();
            async move {
                m.calls.fetch_add(1, Ordering::SeqCst);
                m.seen.lock().unwrap().push((headers, body.0));
                let next = {
                    let mut s = m.script.lock().unwrap();
                    if s.is_empty() {
                        200
                    } else {
                        s.remove(0)
                    }
                };
                if next == 200 {
                    return (
                        StatusCode::OK,
                        axum::Json(json!({
                            "model": "claude-sonnet-5-5",
                            "stop_reason": "end_turn",
                            "content": [{ "type": "text", "text": "{\"ok\": true}" }],
                            "usage": { "input_tokens": 10, "output_tokens": 3 }
                        })),
                    )
                        .into_response();
                }
                let mut r = (
                    StatusCode::from_u16(next).unwrap(),
                    axum::Json(
                        json!({ "type": "error", "error": { "type": "x", "message": "scripted" } }),
                    ),
                )
                    .into_response();
                r.headers_mut().insert("retry-after", "0".parse().unwrap());
                r
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn client(base: String) -> AnthropicLlm {
    AnthropicLlm::new(AnthropicConfig {
        api_key: "test-key".into(),
        model: "claude-sonnet-5-5".into(),
        base_url: base,
        fallbacks: true,
        timeout: Duration::from_secs(10),
    })
    .unwrap()
}

fn req() -> LlmRequest {
    LlmRequest {
        task: "probe",
        system: "Answer in JSON.".into(),
        user_text: "ok?".into(),
        pdf_base64: None,
        schema: json!({ "type": "object", "properties": { "ok": { "type": "boolean" } },
                        "required": ["ok"], "additionalProperties": false }),
        max_tokens: 256,
        effort: "low",
    }
}

#[tokio::test]
async fn sends_the_documented_headers_and_parses_the_answer() {
    let mock = Mock::default();
    let base = serve(mock.clone()).await;
    let res = client(base).complete(req()).await.unwrap();
    assert_eq!(res.value["ok"], true);
    assert_eq!(res.usage.input_tokens, 10);
    let (headers, body) = mock.seen.lock().unwrap()[0].clone();
    assert_eq!(headers["x-api-key"], "test-key");
    assert_eq!(headers["anthropic-version"], "2026-10-21");
    assert_eq!(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert_eq!(body["model"], "claude-sonnet-5-5");
    assert_eq!(body["fallbacks"], "default");
}

#[tokio::test]
async fn overload_and_rate_limits_are_retried() {
    let mock = Mock::default();
    *mock.script.lock().unwrap() = vec![529, 429];
    let base = serve(mock.clone()).await;
    let res = client(base).complete(req()).await.unwrap();
    assert_eq!(res.value["ok"], true);
    assert_eq!(mock.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn client_errors_are_not_retried() {
    let mock = Mock::default();
    *mock.script.lock().unwrap() = vec![400];
    let base = serve(mock.clone()).await;
    let err = client(base).complete(req()).await.unwrap_err();
    assert!(
        matches!(err, LlmError::Upstream(ref m) if m.starts_with("400")),
        "{err:?}"
    );
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn persistent_overload_gives_up_after_bounded_attempts() {
    let mock = Mock::default();
    *mock.script.lock().unwrap() = vec![529; 10];
    let base = serve(mock.clone()).await;
    let err = client(base).complete(req()).await.unwrap_err();
    assert!(matches!(err, LlmError::Upstream(_)));
    assert_eq!(mock.calls.load(Ordering::SeqCst), 4);
}
