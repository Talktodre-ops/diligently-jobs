//! Every email Diligently sends, built on the shared layout. Copy follows the
//! Email boards in docs/design/settings. Builders are pure: callers pass
//! times already formatted in the user's zone (see `crate::notify`).

use super::layout::{Block, Button, Message, Row, Unsubscribe};
use super::Email;

/// The footer and headers for an optional email of `kind`.
pub fn unsubscribe(app: &str, token: &str, kind: &str, reason: &str, label: &str) -> Unsubscribe {
    Unsubscribe {
        reason: reason.to_string(),
        label: label.to_string(),
        page_url: format!("{app}/unsubscribe?token={token}&kind={kind}"),
        one_click_url: format!("{app}/v1/email/unsubscribe/one-click?token={token}&kind={kind}"),
        settings_url: format!("{app}/settings"),
    }
}

fn plural(n: i64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

// ---------------------------------------------------------------------------
// Security emails: always sent, no unsubscribe
// ---------------------------------------------------------------------------

/// Sign-up verification: the 6-digit code on its own line, then the link, so
/// the person can type the code where they are or follow the link anywhere.
pub fn verify_email(to: &str, app: &str, code: &str, link: &str, key: String) -> Email {
    Message::new(
        format!("{code} is your Diligently code"),
        "Enter it where you signed up. It works for 30 minutes.",
        "Your code",
    )
    .para("Type it on the screen where you signed up. It works for 30 minutes.")
    .block(Block::Code(code.to_string()))
    .small("On another device? Confirm with the link instead. It works for 24 hours.")
    .block(Block::Buttons {
        primary: None,
        secondary: Some(Button::new("Confirm my email", link)),
        aside: None,
    })
    .note("Someone signed up for Diligently with this address. If it wasn't you, ignore this email and nothing happens.")
    .into_email(app, to, key)
}

/// The code that deletes an account without a password.
pub fn delete_code(to: &str, app: &str, code: &str, key: String) -> Email {
    Message::new(
        format!("{code} is your code to delete your Diligently account"),
        "It works for 30 minutes. Deleting can't be undone.",
        "Your code to delete your account",
    )
    .para("Type it in Diligently to delete your account. It works for 30 minutes.")
    .block(Block::Code(code.to_string()))
    .para(
        "**This can't be undone.** Your CV, applications, cover letters and files will be deleted.",
    )
    .note("Didn't ask for this? Ignore this email and your account stays as it is.")
    .into_email(app, to, key)
}

pub fn reset_password(to: &str, app: &str, link: &str, key: String) -> Email {
    Message::new(
        "Reset your Diligently password",
        "The link works once, for the next hour.",
        "Choose a new password",
    )
    .para("Someone asked to reset the password for this account. If it was you, pick a new one here. The link works once, for the next hour.")
    .button(Button::new("Choose a new password", link))
    .block(Block::LinkFallback(link.to_string()))
    .note("If it wasn't you, ignore this email. Your password stays the same.")
    .into_email(app, to, key)
}

/// The reset email for an account that has no password yet (Google only).
pub fn set_password(to: &str, app: &str, link: &str, key: String) -> Email {
    Message::new(
        "Set a password for Diligently",
        "The link works once, for the next hour.",
        "Set a password",
    )
    .para("A password lets you sign in without Google. Pick one here. The link works once, for the next hour.")
    .button(Button::new("Set a password", link))
    .block(Block::LinkFallback(link.to_string()))
    .note("If it wasn't you, ignore this email. Nothing changes.")
    .into_email(app, to, key)
}

pub fn confirm_new_email(to: &str, app: &str, link: &str, key: String) -> Email {
    Message::new(
        "Confirm your new email for Diligently",
        "Nothing changes until you confirm.",
        "Use this address?",
    )
    .para(format!("You asked to move your Diligently account to **{to}**. Confirm and it becomes the address you sign in with and where reminders go."))
    .button(Button::new("Confirm new email", link))
    .small("The link works once, for 24 hours.")
    .block(Block::LinkFallback(link.to_string()))
    .note("Didn't ask for this? Ignore it and nothing changes. Once a change goes through, the old address gets a note saying so.")
    .into_email(app, to, key)
}

const SECURITY_NOTE: &str =
    "This is a security email. It always reaches you, whatever your settings.";

/// After a password change, a reset, or a first password being set.
pub fn password_changed(
    to: &str,
    app: &str,
    when: &str,
    device: &str,
    first_password: bool,
    key: String,
) -> Email {
    let (subject, heading) = if first_password {
        (
            "A password was set for your Diligently account",
            "A password was set",
        )
    } else {
        (
            "Your Diligently password was changed",
            "Your password was changed",
        )
    };
    Message::new(subject, "If this was you, there's nothing to do.", heading)
        .para("Every other device was signed out. If this was you, there's nothing to do.")
        .block(Block::Details(vec![
            ("When".into(), when.into()),
            ("Device".into(), device.into()),
        ]))
        .para("**Not you?** Reset your password now. That signs out whoever changed it.")
        .button(Button::new(
            "Reset my password",
            format!("{app}/forgot-password"),
        ))
        .note(SECURITY_NOTE)
        .into_email(app, to, key)
}

/// To the old address once an email change has gone through.
pub fn email_changed(
    to_old: &str,
    new_email: &str,
    app: &str,
    when: &str,
    support: Option<&str>,
    key: String,
) -> Email {
    let mut m = Message::new(
        "Your Diligently email was changed",
        format!("Your account now uses {new_email}."),
        "Your email was changed",
    )
    .para(format!("Your Diligently account now uses **{new_email}**. Sign-in, reminders and security emails go there from now on. This address gets nothing more."))
    .block(Block::Details(vec![
        ("When".into(), when.into()),
        ("New email".into(), new_email.into()),
    ]));
    if let Some(s) = support {
        m = m.para(format!(
            "**Not you?** Write to {s} straight away and we'll help you get your account back."
        ));
    }
    m.button(Button::new("Open Diligently", format!("{app}/settings")))
        .note(SECURITY_NOTE)
        .into_email(app, to_old, key)
}

pub fn google_connected(to: &str, google_email: &str, app: &str, when: &str, key: String) -> Email {
    Message::new(
        "Google was connected to your Diligently account",
        "If this was you, there's nothing to do.",
        "Google was connected",
    )
    .para("You can now sign in to Diligently with Google. If this was you, there's nothing to do.")
    .block(Block::Details(vec![
        ("When".into(), when.into()),
        ("Google".into(), google_email.into()),
    ]))
    .para("**Not you?** Disconnect it in Settings and change your password.")
    .button(Button::new("Open Settings", format!("{app}/settings")))
    .note(SECURITY_NOTE)
    .into_email(app, to, key)
}

pub fn google_disconnected(to: &str, app: &str, when: &str, key: String) -> Email {
    Message::new(
        "Google was disconnected from your Diligently account",
        "If this was you, there's nothing to do.",
        "Google was disconnected",
    )
    .para("You can no longer sign in to Diligently with Google. Use your email and password instead. If this was you, there's nothing to do.")
    .block(Block::Details(vec![("When".into(), when.into())]))
    .para("**Not you?** Reset your password now. That signs every device out.")
    .button(Button::new(
        "Reset my password",
        format!("{app}/forgot-password"),
    ))
    .note(SECURITY_NOTE)
    .into_email(app, to, key)
}

pub struct SignIn<'a> {
    pub device: &'a str,
    pub when: &'a str,
    /// "Password" or "Google".
    pub method: &'a str,
    pub ip: Option<&'a str>,
}

pub fn new_sign_in(to: &str, app: &str, s: &SignIn<'_>, key: String) -> Email {
    let mut details = vec![
        ("Device".to_string(), s.device.to_string()),
        ("When".to_string(), s.when.to_string()),
        ("How".to_string(), s.method.to_string()),
    ];
    if let Some(ip) = s.ip {
        details.push(("IP address".to_string(), ip.to_string()));
    }
    Message::new(
        format!("New sign-in to Diligently: {}", s.device),
        "If this was you, there's nothing to do.",
        "A new device signed in",
    )
    .para("We haven't seen this device on your account before.")
    .block(Block::Details(details))
    .para("If this was you, there's nothing to do. **If it wasn't**, reset your password. That signs every device out, then check your signed-in devices.")
    .block(Block::Buttons {
        primary: Some(Button::new(
            "Reset my password",
            format!("{app}/forgot-password"),
        )),
        secondary: Some(Button::new("See devices", format!("{app}/settings"))),
        aside: None,
    })
    .note(SECURITY_NOTE)
    .into_email(app, to, key)
}

pub fn account_deleted(
    to: &str,
    app: &str,
    when: &str,
    support: Option<&str>,
    key: String,
) -> Email {
    let mut m = Message::new(
        "Your Diligently account is deleted",
        "Everything you stored with us is gone.",
        "Your account is deleted",
    )
    .para(format!("As you asked, we deleted your account on {when}. Your CV, applications, cover letters and files are gone, and reminders have stopped."))
    .para("This is the last email we'll send to this address. Thanks for trying Diligently.");
    if let Some(s) = support {
        m = m.note(format!(
            "Didn't delete it yourself? Write to {s} and we'll look into it."
        ));
    }
    m.into_email(app, to, key)
}

// ---------------------------------------------------------------------------
// Getting started: each goes out once per account
// ---------------------------------------------------------------------------

/// Once the address is confirmed, or a Google account is created.
pub fn welcome(to: &str, app: &str, key: String) -> Email {
    Message::new(
        "Welcome to Diligently",
        "Tailor your CV to a job and apply from your phone.",
        "You're in",
    )
    .para("Diligently tailors your CV and cover letter to each job you want. Both come back properly typeset, and they look the same on your phone as on a laptop, so you can apply from wherever you are.")
    .para("**Add your CV.** Upload it once. We read it, and you check what we found.")
    .para("**Paste a job.** The link or the posting itself.")
    .para("**Download and apply.** Look over what changed, then download your CV and letter and attach them where you apply.")
    .button(Button::new("Tailor my first CV", format!("{app}/")))
    .note("You're getting this because you just created a Diligently account.")
    .into_email(app, to, key)
}

pub struct FirstCv<'a> {
    pub company: Option<&'a str>,
    pub role: Option<&'a str>,
    pub with_letter: bool,
    pub link: &'a str,
}

/// When the first tailoring run finishes.
pub fn first_cv_ready(to: &str, app: &str, f: &FirstCv<'_>, key: String) -> Email {
    let company = f.company.map(str::trim).filter(|c| !c.is_empty());
    let role = f.role.map(str::trim).filter(|r| !r.is_empty());
    let subject = match company {
        Some(c) => format!("Your CV for {c} is ready"),
        None => "Your first tailored CV is ready".to_string(),
    };
    let heading = match (company, role) {
        (Some(c), Some(r)) => format!("{c}, {r}"),
        (Some(c), None) => c.to_string(),
        (None, Some(r)) => r.to_string(),
        (None, None) => "Your first tailored CV".to_string(),
    };
    let target = match (company, role) {
        (Some(c), Some(r)) => format!("the {r} role at {c}"),
        (Some(c), None) => format!("your application to {c}"),
        (None, Some(r)) => format!("the {r} role"),
        (None, None) => "the job you added".to_string(),
    };
    let what = if f.with_letter {
        "Your CV and cover letter are"
    } else {
        "Your CV is"
    };
    let both = if f.with_letter { "both" } else { "it" };
    Message::new(
        subject,
        "Look over what changed, then download it on your phone or laptop.",
        heading,
    )
    .eyebrow("Your first tailored CV")
    .para(format!("{what} tailored to {target}. Look over what changed, keep what sounds like you, then download {both} and apply."))
    .button(Button::new("Open my CV", f.link))
    .small("Every CV you tailor from now on waits for you in Diligently. We only email about it this first time.")
    .into_email(app, to, key)
}

// ---------------------------------------------------------------------------
// Optional emails: each carries a one-click unsubscribe
// ---------------------------------------------------------------------------

pub struct FollowUpDue<'a> {
    pub company: &'a str,
    pub role: &'a str,
    pub days_since_applied: i64,
    pub link: &'a str,
    pub draft_subject: Option<&'a str>,
    pub draft_body: &'a str,
    /// "9:00", in the user's zone.
    pub send_time: &'a str,
    pub skip_weekends: bool,
}

/// "Time to follow up": the reminder, with the drafted message inline so it
/// can be copied straight from the email.
pub fn follow_up_due(
    to: &str,
    app: &str,
    f: &FollowUpDue<'_>,
    unsubscribe: Unsubscribe,
    key: String,
) -> Email {
    let ago = match f.days_since_applied {
        0 => "today".to_string(),
        n => format!("{} ago", plural(n, "day", "days")),
    };
    let lines: Vec<String> = f
        .draft_body
        .split("\n\n")
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let weekends = if f.skip_weekends {
        ", never at weekends"
    } else {
        ""
    };
    let mut u = unsubscribe;
    u.reason = format!(
        "You get this because follow-up reminders are on. They arrive at {} your time{weekends}.",
        f.send_time
    );
    Message::new(
        format!("Time to follow up with {}", f.company),
        format!("You applied {ago}. A short note is drafted below."),
        format!("{}, {}", f.company, f.role),
    )
    .eyebrow("Follow-up due")
    .para(format!("You applied {ago} and haven't heard back. A short, specific note now keeps you in mind. Here's one, written from your application:"))
    .block(Block::Quote {
        subject: f.draft_subject.map(str::to_string),
        lines,
    })
    .block(Block::Buttons {
        primary: Some(Button::new("Open, edit and send", f.link)),
        secondary: None,
        aside: Some("Not yet? Snooze it from there.".into()),
    })
    .unsubscribe(u)
    .into_email(app, to, key)
}

pub struct Weekly<'a> {
    /// "17 November", the local Monday.
    pub week_of: &'a str,
    pub due: i64,
    pub ready: i64,
    pub quiet: i64,
    pub sent_last_week: i64,
    pub rows: Vec<Row>,
    /// First line of the preview, for example "Larkspur Payments is due on Tuesday."
    pub preview: String,
    pub app: &'a str,
    pub send_time: &'a str,
}

fn count_word(n: i64) -> String {
    const WORDS: [&str; 11] = [
        "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    ];
    usize::try_from(n)
        .ok()
        .and_then(|i| WORDS.get(i))
        .map(|w| w.to_string())
        .unwrap_or_else(|| n.to_string())
}

pub fn weekly_summary(to: &str, w: Weekly<'_>, unsubscribe: Unsubscribe, key: String) -> Email {
    let mut parts = Vec::new();
    if w.due > 0 {
        parts.push(plural(w.due, "follow-up due", "follow-ups due"));
    }
    if w.ready > 0 {
        parts.push(plural(w.ready, "draft waiting", "drafts waiting"));
    }
    if w.quiet > 0 {
        parts.push(plural(w.quiet, "quiet application", "quiet applications"));
    }
    let total = w.due + w.ready + w.quiet;
    let heading = if total == 1 {
        "One thing needs you this week".to_string()
    } else {
        format!("{} things need you this week", count_word(total))
    };
    let mut u = unsubscribe;
    u.reason = format!(
        "Sent on Mondays at {} your time, only in weeks with something to do. An empty week sends nothing.",
        w.send_time
    );
    Message::new(
        format!("Your week: {}", parts.join(", ")),
        w.preview,
        heading,
    )
    .eyebrow(format!("Week of {}", w.week_of))
    .block(Block::Stats(vec![
        (
            w.due.to_string(),
            if w.due == 1 {
                "follow-up due"
            } else {
                "follow-ups due"
            }
            .into(),
        ),
        (w.ready.to_string(), "ready to send".into()),
        (w.sent_last_week.to_string(), "sent last week".into()),
    ]))
    .block(Block::Rows(w.rows))
    .button(Button::new("Open Diligently", format!("{}/", w.app)))
    .unsubscribe(u)
    .into_email(w.app, to, key)
}

pub struct RunningLow<'a> {
    pub used: i64,
    pub limit: i64,
    /// "1 December".
    pub resets_on: &'a str,
    pub app: &'a str,
}

pub fn running_low(to: &str, r: &RunningLow<'_>, unsubscribe: Unsubscribe, key: String) -> Email {
    let left = (r.limit - r.used).max(0);
    let title = format!(
        "{} left this month",
        plural(left, "application", "applications")
    );
    let percent = if r.limit > 0 {
        u32::try_from((r.used * 100 / r.limit).clamp(0, 100)).unwrap_or(100)
    } else {
        100
    };
    let mut u = unsubscribe;
    u.reason = "Sent once a month at most.".to_string();
    Message::new(
        title.clone(),
        format!("Your count resets on {}.", r.resets_on),
        title,
    )
    .block(Block::Progress {
        percent,
        caption: format!(
            "{} of {} used. Resets on {}.",
            r.used, r.limit, r.resets_on
        ),
    })
    .para("Worth spending them on the jobs you want most. Anything you have already tailored stays yours to edit and send.")
    .button(Button::new("See your jobs", format!("{}/jobs", r.app)))
    .unsubscribe(u)
    .into_email(r.app, to, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsub() -> Unsubscribe {
        unsubscribe(
            "https://app",
            "tok",
            "weekly_summary",
            "",
            "Stop Monday summaries",
        )
    }

    #[test]
    fn codes_come_before_links_and_stay_on_their_own_line() {
        let e = verify_email(
            "a@b.co",
            "https://app",
            "123456",
            "https://app/verify-email?token=t",
            "k".into(),
        );
        assert_eq!(e.subject, "123456 is your Diligently code");
        assert!(e.text.contains("\n123456\n"));
        assert!(e.text.find("123456") < e.text.find("https://app/verify-email?token=t"));
        let d = delete_code("a@b.co", "https://app", "654321", "k".into());
        assert!(
            !d.subject.contains("is your Diligently code"),
            "not mistaken for a sign-up code"
        );
        assert!(d.text.contains("\n654321\n"));
    }

    #[test]
    fn weekly_subject_and_heading_count_what_needs_doing() {
        let e = weekly_summary(
            "a@b.co",
            Weekly {
                week_of: "17 November",
                due: 2,
                ready: 1,
                quiet: 0,
                sent_last_week: 4,
                rows: vec![],
                preview: "Larkspur Payments is due on Tuesday.".into(),
                app: "https://app",
                send_time: "9:00",
            },
            unsub(),
            "k".into(),
        );
        assert_eq!(e.subject, "Your week: 2 follow-ups due, 1 draft waiting");
        assert!(e.text.contains("Three things need you this week"));
        assert!(e.text.contains("Week of 17 November"));
        assert!(e.text.contains(
            "Stop Monday summaries: https://app/unsubscribe?token=tok&kind=weekly_summary"
        ));
    }

    #[test]
    fn running_low_says_how_many_are_left() {
        let e = running_low(
            "a@b.co",
            &RunningLow {
                used: 8,
                limit: 10,
                resets_on: "1 December",
                app: "https://app",
            },
            unsub(),
            "k".into(),
        );
        assert_eq!(e.subject, "2 applications left this month");
        assert!(e.text.contains("8 of 10 used. Resets on 1 December."));
        assert!(e.html.contains("width:80%"));
    }

    #[test]
    fn no_dashes_in_any_copy() {
        let app = "https://app";
        let all = [
            verify_email("a@b.co", app, "123456", "l", "k".into()),
            delete_code("a@b.co", app, "123456", "k".into()),
            reset_password("a@b.co", app, "l", "k".into()),
            set_password("a@b.co", app, "l", "k".into()),
            confirm_new_email("a@b.co", app, "l", "k".into()),
            password_changed("a@b.co", app, "w", "d", false, "k".into()),
            email_changed("a@b.co", "n@b.co", app, "w", Some("s@b.co"), "k".into()),
            google_connected("a@b.co", "g@b.co", app, "w", "k".into()),
            google_disconnected("a@b.co", app, "w", "k".into()),
            account_deleted("a@b.co", app, "w", Some("s@b.co"), "k".into()),
        ];
        for e in all {
            for bad in ['\u{2014}', '\u{2013}'] {
                assert!(
                    !e.text.contains(bad) && !e.subject.contains(bad),
                    "{}",
                    e.subject
                );
            }
            assert!(!e.text.contains(" -- "), "{}", e.subject);
        }
    }
}
