//! Outbound email. `Mailer` is a trait so production sends through Resend,
//! local development logs the message (links included) and tests capture
//! messages in memory to read the links back.
//!
//! Sending is best-effort from the caller's point of view: account flows log
//! a failed send and carry on, because the user can always ask for another
//! link, and a mail outage must not block sign-up.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use anyhow::{anyhow, Context};
use serde_json::json;

pub mod layout;
pub mod messages;

pub use messages::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
    /// Stable key for this logical message so a retried send is not delivered
    /// twice by the provider.
    pub idempotency_key: String,
    /// Extra headers, such as List-Unsubscribe on optional emails.
    pub headers: Vec<(String, String)>,
}

impl Email {
    fn headers_json(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        serde_json::Value::Object(map)
    }
}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

pub trait Mailer: Send + Sync {
    fn send(&self, email: Email) -> SendFuture<'_>;
}

/// Development mailer: writes the message to the log instead of sending it.
pub struct LogMailer;

impl Mailer for LogMailer {
    fn send(&self, email: Email) -> SendFuture<'_> {
        Box::pin(async move {
            tracing::info!(to = %email.to, subject = %email.subject, "mail (not sent, LogMailer)\n{}", email.text);
            Ok(())
        })
    }
}

/// Local development mailer: logs the message and also writes it as a JSON
/// file into a directory (MAIL_OUTBOX_DIR), so browser tests can read the
/// verification and reset links a real inbox would get.
pub struct FileMailer {
    dir: std::path::PathBuf,
}

impl FileMailer {
    pub fn new(dir: impl Into<std::path::PathBuf>) -> anyhow::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("create mail outbox {}", dir.display()))?;
        Ok(Self { dir })
    }
}

impl Mailer for FileMailer {
    fn send(&self, email: Email) -> SendFuture<'_> {
        Box::pin(async move {
            tracing::info!(to = %email.to, subject = %email.subject, "mail (not sent, written to outbox)\n{}", email.text);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros();
            let safe_to: String = email
                .to
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '@' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let path = self.dir.join(format!("{stamp}-{safe_to}.json"));
            // Browser tests read `to`, `subject` and `text`; html and headers
            // are there for looking at the message locally.
            let body = json!({
                "to": email.to,
                "subject": email.subject,
                "text": email.text,
                "html": email.html,
                "headers": email.headers_json(),
            });
            tokio::fs::write(&path, serde_json::to_vec_pretty(&body)?)
                .await
                .with_context(|| format!("write {}", path.display()))?;
            Ok(())
        })
    }
}

/// Test mailer: keeps every message so tests can assert on it.
#[derive(Default)]
pub struct MemoryMailer {
    sent: Mutex<Vec<Email>>,
}

impl MemoryMailer {
    pub fn sent(&self) -> Vec<Email> {
        self.sent.lock().expect("mailer lock").clone()
    }

    pub fn last_to(&self, to: &str) -> Option<Email> {
        self.sent().into_iter().rev().find(|e| e.to == to)
    }
}

impl Mailer for MemoryMailer {
    fn send(&self, email: Email) -> SendFuture<'_> {
        Box::pin(async move {
            self.sent.lock().expect("mailer lock").push(email);
            Ok(())
        })
    }
}

/// Resend HTTP API (POST https://api.resend.com/emails). Custom headers go in
/// the body's `headers` object, as Resend's send-email reference describes.
pub struct ResendMailer {
    client: reqwest::Client,
    api_key: String,
    from: String,
    endpoint: String,
}

const RESEND_ENDPOINT: &str = "https://api.resend.com/emails";

impl ResendMailer {
    pub fn new(api_key: String, from: String) -> anyhow::Result<Self> {
        Self::with_endpoint(api_key, from, RESEND_ENDPOINT.to_string())
    }

    /// Same, posting to another URL. Only tests use this, against a local
    /// stand-in for Resend.
    pub fn with_endpoint(api_key: String, from: String, endpoint: String) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .context("build mail http client")?;
        Ok(Self {
            client,
            api_key,
            from,
            endpoint,
        })
    }
}

impl Mailer for ResendMailer {
    fn send(&self, email: Email) -> SendFuture<'_> {
        Box::pin(async move {
            let mut body = json!({
                "from": self.from,
                "to": [email.to],
                "subject": email.subject,
                "text": email.text,
                "html": email.html,
            });
            if !email.headers.is_empty() {
                body["headers"] = email.headers_json();
            }
            let resp = self
                .client
                .post(&self.endpoint)
                .bearer_auth(&self.api_key)
                .header("Idempotency-Key", &email.idempotency_key)
                .json(&body)
                .send()
                .await
                .context("resend request failed")?;
            let status = resp.status();
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                // The body describes the problem (bad from domain, quota) and
                // never contains our key, so it is safe to log.
                return Err(anyhow!(
                    "resend returned {status}: {}",
                    truncate(&body, 500)
                ));
            }
            Ok(())
        })
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Pick the mailer from env: Resend when RESEND_API_KEY is set (MAIL_FROM is
/// then required), otherwise the logging mailer for local development.
pub fn from_env() -> anyhow::Result<std::sync::Arc<dyn Mailer>> {
    match std::env::var("RESEND_API_KEY") {
        Ok(key) if !key.trim().is_empty() => {
            let from = std::env::var("MAIL_FROM")
                .map_err(|_| anyhow!("MAIL_FROM is required when RESEND_API_KEY is set"))?;
            tracing::info!("mail: sending through Resend");
            Ok(std::sync::Arc::new(ResendMailer::new(
                key.trim().to_string(),
                from,
            )?))
        }
        _ => match std::env::var("MAIL_OUTBOX_DIR") {
            Ok(dir) if !dir.trim().is_empty() => {
                tracing::warn!(outbox = %dir.trim(), "mail: RESEND_API_KEY not set, emails go to the outbox directory");
                Ok(std::sync::Arc::new(FileMailer::new(dir.trim())?))
            }
            _ => {
                tracing::warn!("mail: RESEND_API_KEY not set, emails are only logged");
                Ok(std::sync::Arc::new(LogMailer))
            }
        },
    }
}

/// Send and log failures instead of propagating them.
pub async fn send_best_effort(mailer: &dyn Mailer, email: Email) {
    let to = email.to.clone();
    let subject = email.subject.clone();
    if let Err(err) = mailer.send(email).await {
        tracing::error!(%to, %subject, error = %format!("{err:#}"), "mail send failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_mailer_writes_one_json_file_per_message() {
        let dir = tempfile::tempdir().unwrap();
        let m = FileMailer::new(dir.path().join("outbox")).unwrap();
        m.send(verify_email(
            "ada@example.com",
            "123456",
            "https://app/verify?token=t1",
            "k".into(),
        ))
        .await
        .unwrap();
        let files: Vec<_> = std::fs::read_dir(dir.path().join("outbox"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap();
        assert_eq!(v["to"], "ada@example.com");
        assert!(v["text"].as_str().unwrap().contains("token=t1"));
    }

    #[tokio::test]
    async fn resend_request_carries_custom_headers() {
        use axum::http::HeaderMap;
        use std::sync::{Arc, Mutex};

        type Seen = Arc<Mutex<Option<(HeaderMap, serde_json::Value)>>>;
        let seen: Seen = Arc::default();
        let store = seen.clone();
        let router = axum::Router::new().route(
            "/emails",
            axum::routing::post(
                move |headers: HeaderMap, axum::Json(body): axum::Json<serde_json::Value>| {
                    let store = store.clone();
                    async move {
                        *store.lock().unwrap() = Some((headers, body));
                        axum::Json(json!({ "id": "x" }))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let m = ResendMailer::with_endpoint(
            "test-key".into(),
            "Diligently <hello@example.com>".into(),
            format!("http://{addr}/emails"),
        )
        .unwrap();
        let mut e = reset_password("ada@example.com", "https://app/r", "key-1".into());
        e.headers = vec![("List-Unsubscribe".into(), "<https://app/u>".into())];
        m.send(e).await.unwrap();

        let (headers, body) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(headers["idempotency-key"], "key-1");
        assert_eq!(headers["authorization"], "Bearer test-key");
        assert_eq!(body["to"], json!(["ada@example.com"]));
        assert_eq!(
            body["headers"],
            json!({ "List-Unsubscribe": "<https://app/u>" })
        );
        assert!(body["html"]
            .as_str()
            .unwrap()
            .contains("Choose a new password"));
        assert!(body["text"].as_str().unwrap().contains("https://app/r"));
    }

    #[tokio::test]
    async fn memory_mailer_captures_messages() {
        let m = MemoryMailer::default();
        send_best_effort(&m, reset_password("a@b.co", "https://app/r", "k".into())).await;
        assert_eq!(
            m.last_to("a@b.co").unwrap().subject,
            "Reset your Diligently password"
        );
    }
}
