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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
    /// Stable key for this logical message so a retried send is not delivered
    /// twice by the provider.
    pub idempotency_key: String,
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
            let body = json!({ "to": email.to, "subject": email.subject, "text": email.text });
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

/// Resend HTTP API (POST https://api.resend.com/emails).
pub struct ResendMailer {
    client: reqwest::Client,
    api_key: String,
    from: String,
}

impl ResendMailer {
    pub fn new(api_key: String, from: String) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .context("build mail http client")?;
        Ok(Self {
            client,
            api_key,
            from,
        })
    }
}

impl Mailer for ResendMailer {
    fn send(&self, email: Email) -> SendFuture<'_> {
        Box::pin(async move {
            let resp = self
                .client
                .post("https://api.resend.com/emails")
                .bearer_auth(&self.api_key)
                .header("Idempotency-Key", &email.idempotency_key)
                .json(&json!({
                    "from": self.from,
                    "to": [email.to],
                    "subject": email.subject,
                    "text": email.text,
                    "html": email.html,
                }))
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

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// One message with a single call-to-action link, as text and simple HTML.
fn link_email(
    to: &str,
    subject: &str,
    intro: &str,
    cta: &str,
    link: &str,
    outro: &str,
    key: String,
) -> Email {
    let text = format!("{intro}\n\n{cta}: {link}\n\n{outro}\n\nDiligently");
    let html = format!(
        "<div style=\"font-family:Inter,Arial,sans-serif;color:#3B1C32;max-width:520px\">\
         <p>{}</p><p><a href=\"{}\" style=\"display:inline-block;background:#C2471F;color:#ffffff;\
         padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600\">{}</a></p>\
         <p style=\"font-size:13px;color:#6B4E62\">{}</p><p style=\"font-size:13px;color:#6B4E62\">\
         If the button does not work, paste this into your browser:<br>{}</p></div>",
        escape_html(intro),
        escape_html(link),
        escape_html(cta),
        escape_html(outro),
        escape_html(link),
    );
    Email {
        to: to.to_string(),
        subject: subject.to_string(),
        text,
        html,
        idempotency_key: key,
    }
}

/// Sign-up verification: the 6-digit code on its own line, then the link, so
/// the person can type the code where they are or follow the link anywhere.
pub fn verify_email(to: &str, code: &str, link: &str, key: String) -> Email {
    let intro = "Enter this code in Diligently to confirm your email:";
    let outro = "The code expires in 30 minutes and the link in 24 hours. If you did not sign up, ignore this email.";
    let text =
        format!("{intro}\n\n{code}\n\nOr confirm with this link: {link}\n\n{outro}\n\nDiligently");
    let html = format!(
        "<div style=\"font-family:Inter,Arial,sans-serif;color:#3B1C32;max-width:520px\">\
         <p>{}</p><p style=\"font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0\">{}</p>\
         <p>Or confirm with this link:</p><p><a href=\"{}\" style=\"display:inline-block;background:#C2471F;\
         color:#ffffff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600\">Confirm email</a></p>\
         <p style=\"font-size:13px;color:#6B4E62\">{}</p><p style=\"font-size:13px;color:#6B4E62\">\
         If the button does not work, paste this into your browser:<br>{}</p></div>",
        escape_html(intro),
        escape_html(code),
        escape_html(link),
        escape_html(outro),
        escape_html(link),
    );
    Email {
        to: to.to_string(),
        subject: format!("{code} is your Diligently code"),
        text,
        html,
        idempotency_key: key,
    }
}

pub fn reset_password(to: &str, link: &str, key: String) -> Email {
    link_email(
        to,
        "Reset your Diligently password",
        "Someone asked to reset the password for this account.",
        "Choose a new password",
        link,
        "The link works once and expires in 1 hour. If it was not you, ignore this email and your password stays the same.",
        key,
    )
}

pub fn confirm_new_email(to: &str, link: &str, key: String) -> Email {
    link_email(
        to,
        "Confirm your new email for Diligently",
        "Confirm that you want to use this address for your Diligently account.",
        "Confirm new email",
        link,
        "The link works once and expires in 24 hours. If you did not ask for this, ignore this email.",
        key,
    )
}

/// "Time to follow up": the reminder, with the drafted message inline so it
/// can be copied straight from the email.
pub fn follow_up_due(
    to: &str,
    company: &str,
    role: &str,
    link: &str,
    draft_subject: Option<&str>,
    draft_body: &str,
    key: String,
) -> Email {
    let intro = format!("It is time to follow up on your application for {role} at {company}. A draft is ready below and in the app.");
    let draft = match draft_subject {
        Some(s) => format!("Subject: {s}\n\n{draft_body}"),
        None => draft_body.to_string(),
    };
    let mut e = link_email(
        to,
        &format!("Follow up with {company}"),
        &intro,
        "Open the follow-up",
        link,
        "You can turn these reminders off in Settings.",
        key,
    );
    e.text = format!("{}\n\n---\n{draft}\n---", e.text);
    e.html = format!(
        "{}<pre style=\"white-space:pre-wrap;font-family:Inter,Arial,sans-serif;background:#FCF8EC;padding:12px;border-radius:8px\">{}</pre>",
        e.html,
        escape_html(&draft)
    );
    e
}

pub fn password_changed(to: &str, key: String) -> Email {
    let text = "Your Diligently password was just changed, and other devices were signed out.\n\nIf this was not you, reset your password now from the sign-in page.\n\nDiligently".to_string();
    let html = format!(
        "<div style=\"font-family:Inter,Arial,sans-serif;color:#3B1C32\"><p>{}</p></div>",
        escape_html(&text).replace('\n', "<br>")
    );
    Email {
        to: to.to_string(),
        subject: "Your Diligently password was changed".to_string(),
        text,
        html,
        idempotency_key: key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_is_escaped_in_html_and_plain_in_text() {
        let e = verify_email("a@b.co", "123456", "https://app/x?token=a&b", "k".into());
        assert_eq!(e.subject, "123456 is your Diligently code");
        assert!(e.text.contains("\n123456\n"), "code on its own line");
        assert!(e.text.find("123456") < e.text.find("https://app/x"));
        assert!(e.text.contains("https://app/x?token=a&b"));
        assert!(e.html.contains("https://app/x?token=a&amp;b"));
        assert!(!e.html.contains("token=a&b"));
    }

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
    async fn memory_mailer_captures_messages() {
        let m = MemoryMailer::default();
        send_best_effort(&m, password_changed("a@b.co", "k".into())).await;
        assert_eq!(
            m.last_to("a@b.co").unwrap().subject,
            "Your Diligently password was changed"
        );
    }
}
