//! The one layout every email uses, after the Email boards in
//! docs/design/settings: the logo, a white card on a warm background
//! with a heading and body, and a footer under the card. HTML with inline
//! styles only (email clients drop style sheets), tables for anything laid
//! out side by side, a hidden preheader, and a plain-text part that carries
//! every code and link.
//!
//! Text in blocks may mark bold with `**double asterisks**`; the HTML part
//! renders them as <strong> and the text part drops the markers.

use super::Email;

const BG: &str = "#F6EFDC";
const INK: &str = "#3B1C32";
const MUTED: &str = "#5E4456";
const LINE: &str = "#EADFC2";
const SOFT: &str = "#FCF8EC";
const RULE: &str = "#F1E8D2";
const ACCENT: &str = "#C2471F";
const ACCENT_TEXT: &str = "#B5401C";
const BORDER: &str = "#D9CCAE";
const SANS: &str = "Inter, Arial, sans-serif";
const SERIF: &str = "Fraunces, Georgia, serif";

#[derive(Debug, Clone)]
pub struct Button {
    pub label: String,
    pub url: String,
}

impl Button {
    pub fn new(label: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            url: url.into(),
        }
    }
}

/// One line in a list such as the weekly summary's.
#[derive(Debug, Clone)]
pub struct Row {
    /// Short label on the left ("Tue", "Any day", "Quiet").
    pub label: String,
    pub title: String,
    pub detail: String,
    /// Label in the accent colour rather than muted.
    pub accent: bool,
}

#[derive(Debug, Clone)]
pub enum Block {
    /// A body paragraph.
    Para(String),
    /// A small muted line inside the card.
    Small(String),
    /// A one-time code in a large box, on its own line in the text part.
    Code(String),
    /// Label and value pairs (when, device, IP).
    Details(Vec<(String, String)>),
    /// A quoted draft. Lines are paragraphs; `subject` is shown above them.
    Quote {
        subject: Option<String>,
        lines: Vec<String>,
    },
    /// Big numbers with a caption under each.
    Stats(Vec<(String, String)>),
    Rows(Vec<Row>),
    /// A bar `percent` full with a caption.
    Progress {
        percent: u32,
        caption: String,
    },
    /// A filled primary button, an outlined secondary one, and a short note
    /// beside them.
    Buttons {
        primary: Option<Button>,
        secondary: Option<Button>,
        aside: Option<String>,
    },
    /// "Button not working?" with the raw link, for links carrying a token.
    LinkFallback(String),
}

/// The footer of an optional email: why it came, and how to stop it.
#[derive(Debug, Clone)]
pub struct Unsubscribe {
    pub reason: String,
    /// Link text, for example "Turn off follow-up reminders".
    pub label: String,
    /// The web page that turns it off.
    pub page_url: String,
    /// The API endpoint for RFC 8058 one-click unsubscribe.
    pub one_click_url: String,
    pub settings_url: String,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub subject: String,
    pub preheader: String,
    /// Small uppercase line above the heading.
    pub eyebrow: Option<String>,
    pub heading: String,
    pub blocks: Vec<Block>,
    /// Muted lines under the card.
    pub notes: Vec<String>,
    pub unsubscribe: Option<Unsubscribe>,
}

impl Message {
    pub fn new(
        subject: impl Into<String>,
        preheader: impl Into<String>,
        heading: impl Into<String>,
    ) -> Self {
        Self {
            subject: subject.into(),
            preheader: preheader.into(),
            eyebrow: None,
            heading: heading.into(),
            blocks: Vec::new(),
            notes: Vec::new(),
            unsubscribe: None,
        }
    }

    pub fn eyebrow(mut self, s: impl Into<String>) -> Self {
        self.eyebrow = Some(s.into());
        self
    }

    pub fn block(mut self, b: Block) -> Self {
        self.blocks.push(b);
        self
    }

    pub fn para(self, s: impl Into<String>) -> Self {
        self.block(Block::Para(s.into()))
    }

    pub fn small(self, s: impl Into<String>) -> Self {
        self.block(Block::Small(s.into()))
    }

    pub fn button(self, b: Button) -> Self {
        self.block(Block::Buttons {
            primary: Some(b),
            secondary: None,
            aside: None,
        })
    }

    pub fn note(mut self, s: impl Into<String>) -> Self {
        self.notes.push(s.into());
        self
    }

    pub fn unsubscribe(mut self, u: Unsubscribe) -> Self {
        self.unsubscribe = Some(u);
        self
    }

    /// `app` is APP_BASE_URL, where the web app serves the logo image.
    pub fn into_email(self, app: &str, to: &str, idempotency_key: String) -> Email {
        let headers = match &self.unsubscribe {
            Some(u) => vec![
                (
                    "List-Unsubscribe".to_string(),
                    format!("<{}>", u.one_click_url),
                ),
                (
                    "List-Unsubscribe-Post".to_string(),
                    "List-Unsubscribe=One-Click".to_string(),
                ),
            ],
            None => Vec::new(),
        };
        Email {
            to: to.to_string(),
            subject: self.subject.clone(),
            text: self.text(),
            html: self.html(app),
            idempotency_key,
            headers,
        }
    }

    fn text(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut head = String::new();
        if let Some(e) = &self.eyebrow {
            head.push_str(e);
            head.push('\n');
        }
        head.push_str(&self.heading);
        parts.push(head);
        for b in &self.blocks {
            parts.push(block_text(b));
        }
        for n in &self.notes {
            parts.push(plain(n));
        }
        if let Some(u) = &self.unsubscribe {
            parts.push(format!(
                "{}\n{}: {}\nEmail settings: {}",
                plain(&u.reason),
                u.label,
                u.page_url,
                u.settings_url
            ));
        }
        parts.push("Diligently".to_string());
        parts
            .into_iter()
            .filter(|p| !p.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn html(&self, app: &str) -> String {
        let mut card = String::new();
        if let Some(e) = &self.eyebrow {
            card.push_str(&format!(
                "<p style=\"margin:0 0 6px;font-family:{SANS};font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:{ACCENT_TEXT}\">{}</p>",
                esc(e)
            ));
        }
        card.push_str(&format!(
            "<h1 style=\"margin:0 0 18px;font-family:{SERIF};font-weight:400;font-size:30px;line-height:1.1;color:{INK}\">{}</h1>",
            esc(&self.heading)
        ));
        for b in &self.blocks {
            card.push_str(&block_html(b));
        }

        let mut below = String::new();
        for n in &self.notes {
            below.push_str(&format!(
                "<p style=\"margin:0 0 8px;font-size:13px;line-height:1.6;color:{MUTED}\">{}</p>",
                rich(n)
            ));
        }
        if let Some(u) = &self.unsubscribe {
            below.push_str(&format!(
                "<p style=\"margin:0 0 6px;font-size:13px;line-height:1.6;color:{MUTED}\">{}</p>\
                 <p style=\"margin:0;font-size:13px;line-height:1.6;color:{MUTED}\">\
                 <a href=\"{}\" style=\"color:{ACCENT_TEXT}\">{}</a> &middot; \
                 <a href=\"{}\" style=\"color:{ACCENT_TEXT}\">Email settings</a></p>",
                rich(&u.reason),
                esc(&u.page_url),
                esc(&u.label),
                esc(&u.settings_url)
            ));
        }

        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
             <title>{title}</title></head>\
             <body style=\"margin:0;padding:0;background:{BG}\">\
             <span style=\"display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:{BG}\">{pre}</span>\
             <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:{BG}\"><tr><td align=\"center\" style=\"padding:28px 16px 32px\">\
             <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"max-width:600px;font-family:{SANS};color:{INK}\">\
             <tr><td style=\"padding:4px 8px 18px\"><img src=\"{logo}\" width=\"180\" height=\"34\" alt=\"Diligently\" style=\"display:block;border:0\"></td></tr>\
             <tr><td style=\"background:#FFFFFF;border:1px solid {LINE};border-radius:16px;padding:36px 32px 32px\">{card}</td></tr>\
             <tr><td style=\"padding:18px 8px 0\">{below}</td></tr>\
             </table></td></tr></table></body></html>",
            title = esc(&self.subject),
            pre = esc(&self.preheader),
            logo = esc(&format!("{app}/email/lockup.png")),
        )
    }
}

fn block_text(b: &Block) -> String {
    match b {
        Block::Para(s) | Block::Small(s) => plain(s),
        Block::Code(c) => c.clone(),
        Block::Details(pairs) => pairs
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join("\n"),
        Block::Quote { subject, lines } => {
            let mut s = String::from("---\n");
            if let Some(sub) = subject {
                s.push_str(&format!("Subject: {sub}\n\n"));
            }
            s.push_str(&lines.join("\n\n"));
            s.push_str("\n---");
            s
        }
        Block::Stats(items) => items
            .iter()
            .map(|(n, label)| format!("{n} {label}"))
            .collect::<Vec<_>>()
            .join("\n"),
        Block::Rows(rows) => rows
            .iter()
            .map(|r| format!("{}: {}\n{}", r.label, r.title, r.detail))
            .collect::<Vec<_>>()
            .join("\n\n"),
        Block::Progress { caption, .. } => caption.clone(),
        Block::Buttons {
            primary,
            secondary,
            aside,
        } => {
            let mut lines = Vec::new();
            for b in [primary, secondary].into_iter().flatten() {
                lines.push(format!("{}: {}", b.label, b.url));
            }
            if let Some(a) = aside {
                lines.push(plain(a));
            }
            lines.join("\n")
        }
        // The text part already shows every link in full.
        Block::LinkFallback(_) => String::new(),
    }
}

fn block_html(b: &Block) -> String {
    let p = |size: u32, color: &str, s: &str| {
        format!(
            "<p style=\"margin:0 0 18px;font-size:{size}px;line-height:1.6;color:{color}\">{}</p>",
            rich(s)
        )
    };
    match b {
        Block::Para(s) => p(16, INK, s),
        Block::Small(s) => p(13, MUTED, s),
        Block::Code(c) => format!(
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 18px\"><tr>\
             <td style=\"background:{SOFT};border:1px solid {LINE};border-radius:12px;padding:14px 22px;font-size:38px;font-weight:700;letter-spacing:0.22em;color:{INK}\">{}</td></tr></table>",
            esc(c)
        ),
        Block::Details(pairs) => {
            let rows: String = pairs
                .iter()
                .map(|(k, v)| {
                    format!(
                        "<tr><td style=\"padding:4px 12px 4px 0;width:90px;vertical-align:top;color:{MUTED}\">{}</td>\
                         <td style=\"padding:4px 0;vertical-align:top;color:{INK}\">{}</td></tr>",
                        esc(k),
                        esc(v)
                    )
                })
                .collect();
            format!(
                "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 18px;background:{SOFT};border-radius:12px\"><tr><td style=\"padding:10px 16px\">\
                 <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"font-size:14px\">{rows}</table></td></tr></table>"
            )
        }
        Block::Quote { subject, lines } => {
            let mut inner = String::new();
            if let Some(s) = subject {
                inner.push_str(&format!(
                    "<p style=\"margin:0 0 12px;font-size:13px;color:{MUTED}\"><strong style=\"color:{INK}\">Subject</strong> {}</p>",
                    esc(s)
                ));
            }
            for l in lines {
                inner.push_str(&format!(
                    "<p style=\"margin:0 0 12px;font-size:15px;line-height:1.6;color:{INK}\">{}</p>",
                    esc(l).replace('\n', "<br>")
                ));
            }
            format!(
                "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 18px\"><tr>\
                 <td style=\"background:{SOFT};border:1px solid {LINE};border-radius:12px;padding:18px 20px 6px\">{inner}</td></tr></table>"
            )
        }
        Block::Stats(items) => {
            let cells: String = items
                .iter()
                .map(|(n, label)| {
                    format!(
                        "<td width=\"{w}%\" style=\"padding:0 5px;vertical-align:top\">\
                         <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td style=\"background:{SOFT};border-radius:12px;padding:14px\">\
                         <div style=\"font-family:{SERIF};font-size:30px;line-height:1.1;color:{INK}\">{}</div>\
                         <div style=\"font-size:13px;color:{MUTED}\">{}</div></td></tr></table></td>",
                        esc(n),
                        esc(label),
                        w = 100 / items.len().max(1)
                    )
                })
                .collect();
            format!(
                "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 22px\"><tr>{cells}</tr></table>"
            )
        }
        Block::Rows(rows) => {
            let n = rows.len();
            let body: String = rows
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let bottom = if i + 1 == n {
                        format!("border-bottom:1px solid {RULE};")
                    } else {
                        String::new()
                    };
                    let color = if r.accent { ACCENT_TEXT } else { MUTED };
                    format!(
                        "<tr><td style=\"width:64px;padding:14px 14px 14px 0;border-top:1px solid {RULE};{bottom}vertical-align:top;font-size:13px;font-weight:600;color:{color}\">{}</td>\
                         <td style=\"padding:14px 0;border-top:1px solid {RULE};{bottom}vertical-align:top\">\
                         <div style=\"font-weight:600;color:{INK}\">{}</div><div style=\"font-size:14px;color:{MUTED}\">{}</div></td></tr>",
                        esc(&r.label),
                        esc(&r.title),
                        esc(&r.detail)
                    )
                })
                .collect();
            format!(
                "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 22px\">{body}</table>"
            )
        }
        Block::Progress { percent, caption } => {
            let pct = (*percent).min(100);
            format!(
                "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 8px\"><tr>\
                 <td style=\"background:{RULE};border-radius:999px;height:10px;line-height:10px;font-size:0\">\
                 <div style=\"width:{pct}%;height:10px;background:{ACCENT};border-radius:999px\"></div></td></tr></table>\
                 <p style=\"margin:0 0 18px;font-size:14px;color:{MUTED}\">{}</p>",
                esc(caption)
            )
        }
        Block::Buttons {
            primary,
            secondary,
            aside,
        } => {
            let mut cells = String::new();
            if let Some(b) = primary {
                cells.push_str(&format!(
                    "<td style=\"padding:0 12px 0 0\"><a href=\"{}\" style=\"display:inline-block;background:{ACCENT};color:#FFFFFF;padding:14px 24px;border-radius:999px;text-decoration:none;font-weight:600;font-size:16px\">{}</a></td>",
                    esc(&b.url),
                    esc(&b.label)
                ));
            }
            if let Some(b) = secondary {
                cells.push_str(&format!(
                    "<td style=\"padding:0 12px 0 0\"><a href=\"{}\" style=\"display:inline-block;background:#FFFFFF;border:1.5px solid {BORDER};color:{INK};padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px\">{}</a></td>",
                    esc(&b.url),
                    esc(&b.label)
                ));
            }
            if let Some(a) = aside {
                cells.push_str(&format!(
                    "<td style=\"font-size:14px;color:{MUTED}\">{}</td>",
                    rich(a)
                ));
            }
            format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:4px 0 18px\"><tr>{cells}</tr></table>"
            )
        }
        Block::LinkFallback(url) => format!(
            "<p style=\"margin:0 0 4px;font-size:13px;line-height:1.6;color:{MUTED}\">Button not working? Paste this into your browser:<br>\
             <span style=\"color:{INK};word-break:break-all\">{}</span></p>",
            esc(url)
        ),
    }
}

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Escaped HTML with `**bold**` turned into <strong>.
fn rich(s: &str) -> String {
    let mut out = String::new();
    for (i, part) in s.split("**").enumerate() {
        if i % 2 == 1 {
            out.push_str(&format!("<strong>{}</strong>", esc(part)));
        } else {
            out.push_str(&esc(part));
        }
    }
    out
}

/// The text with bold markers removed.
fn plain(s: &str) -> String {
    s.replace("**", "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Message {
        Message::new("Subject & more", "Preview line", "Heading")
            .para("Hello **Ada** <b>")
            .block(Block::Code("482915".into()))
            .button(Button::new("Go", "https://app/x?token=a&b"))
            .note("A note.")
    }

    #[test]
    fn html_escapes_and_bolds_while_text_stays_plain() {
        let e = sample().into_email("https://app", "a@b.co", "k".into());
        assert!(e.html.contains(
            "<img src=\"https://app/email/lockup.png\" width=\"180\" height=\"34\" alt=\"Diligently\" style=\"display:block;border:0\">"
        ));
        assert!(e.text.starts_with("Heading"), "no logo in the text part");
        assert!(e.html.contains("Hello <strong>Ada</strong> &lt;b&gt;"));
        assert!(e.html.contains("https://app/x?token=a&amp;b"));
        assert!(!e.html.contains("token=a&b"));
        assert!(e.html.contains("Preview line"), "preheader present");
        assert!(e.text.contains("Hello Ada <b>"));
        assert!(e.text.contains("\n482915\n"), "code on its own line");
        assert!(e.text.contains("Go: https://app/x?token=a&b"));
        assert!(e.headers.is_empty(), "no unsubscribe on security mail");
        assert!(!e.html.contains("<style"), "inline styles only");
    }

    #[test]
    fn optional_mail_carries_one_click_headers_and_footer() {
        let e = sample()
            .unsubscribe(Unsubscribe {
                reason: "You get this because x is on.".into(),
                label: "Turn off x".into(),
                page_url: "https://app/unsubscribe?token=t&kind=follow_ups".into(),
                one_click_url: "https://app/v1/email/unsubscribe/one-click?token=t&kind=follow_ups"
                    .into(),
                settings_url: "https://app/settings".into(),
            })
            .into_email("https://app", "a@b.co", "k".into());
        assert_eq!(
            e.headers,
            vec![
                (
                    "List-Unsubscribe".to_string(),
                    "<https://app/v1/email/unsubscribe/one-click?token=t&kind=follow_ups>"
                        .to_string()
                ),
                (
                    "List-Unsubscribe-Post".to_string(),
                    "List-Unsubscribe=One-Click".to_string()
                ),
            ]
        );
        assert!(e
            .text
            .contains("Turn off x: https://app/unsubscribe?token=t&kind=follow_ups"));
        assert!(e.html.contains("Turn off x</a>"));
    }
}
