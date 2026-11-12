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
        _ => {
            tracing::warn!("mail: RESEND_API_KEY not set, emails are only logged");
            Ok(std::sync::Arc::new(LogMailer))
        }
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

pub fn verify_email(to: &str, link: &str, key: String) -> Email {
    link_email(
        to,
        "Confirm your email for Diligently",
        "Confirm this address to start tailoring your CV.",
        "Confirm email",
        link,
        "The link works once and expires in 24 hours. If you did not sign up, ignore this email.",
        key,
    )
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
        let e = verify_email("a@b.co", "https://app/x?token=a&b", "k".into());
        assert!(e.text.contains("https://app/x?token=a&b"));
        assert!(e.html.contains("https://app/x?token=a&amp;b"));
        assert!(!e.html.contains("token=a&b"));
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
