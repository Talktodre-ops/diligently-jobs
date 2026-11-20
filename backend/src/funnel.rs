//! The product funnel, read from data the app already keeps.
//!
//! Each step is a fact about an account: it signed up, verified, added a CV,
//! started an application, got a tailored CV back, downloaded the files,
//! marked one as sent, followed up, and came back a week later. Only the
//! download needs its own event (`files_downloaded`, posted by the web app);
//! everything else comes from the tables the features write anyway, so the
//! numbers cover history from before this report existed.
//!
//! Test and internal accounts are left out: `@example.com` (the browser
//! tests) and `@diligently.local` (the legacy owner).

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};

/// Event kind the web app posts when a CV or letter leaves through Send.
pub const FILES_DOWNLOADED: &str = "files_downloaded";

pub const STEPS: [&str; 9] = [
    "signed up",
    "verified",
    "added a CV",
    "started",
    "tailored",
    "downloaded",
    "sent",
    "followed up",
    "came back",
];

#[derive(Debug, Clone, FromRow)]
pub struct Cohort {
    /// Monday of the sign-up week, UTC.
    pub week: DateTime<Utc>,
    pub signed_up: i64,
    pub verified: i64,
    pub cv: i64,
    pub started: i64,
    pub tailored: i64,
    pub downloaded: i64,
    pub sent: i64,
    pub followed_up: i64,
    pub came_back: i64,
}

impl Cohort {
    pub fn steps(&self) -> [i64; 9] {
        [
            self.signed_up,
            self.verified,
            self.cv,
            self.started,
            self.tailored,
            self.downloaded,
            self.sent,
            self.followed_up,
            self.came_back,
        ]
    }
}

#[derive(Debug, Clone)]
pub struct Report {
    pub weeks: i32,
    pub cohorts: Vec<Cohort>,
    /// Median minutes from sign-up to the first tailored CV.
    pub to_first_tailored_min: Option<f64>,
    /// Median seconds a tailoring run took, over the same weeks.
    pub tailoring_secs: Option<f64>,
}

impl Report {
    pub fn total(&self) -> [i64; 9] {
        self.cohorts.iter().fold([0; 9], |mut acc, c| {
            for (a, n) in acc.iter_mut().zip(c.steps()) {
                *a += n;
            }
            acc
        })
    }
}

/// Accounts that signed up in the last `weeks` weeks (this week included),
/// one row per sign-up week with how many reached each step.
pub async fn report(db: &PgPool, weeks: i32) -> sqlx::Result<Report> {
    let cohorts: Vec<Cohort> = sqlx::query_as(
        r#"
        with people as (
            select u.id, u.created_at,
                   date_trunc('week', u.created_at) as week,
                   u.email_verified_at is not null as verified,
                   p.master_cv_version_id is not null as cv,
                   exists (select 1 from applications a where a.user_id = u.id) as started,
                   exists (select 1 from events e where e.user_id = u.id and e.kind = 'pipeline_done') as tailored,
                   exists (select 1 from events e where e.user_id = u.id and e.kind = $2) as downloaded,
                   exists (select 1 from applications a where a.user_id = u.id and a.submitted_at is not null) as sent,
                   exists (select 1 from follow_ups f where f.user_id = u.id)
                     or exists (select 1 from reminders r where r.user_id = u.id and r.status = 'done') as followed_up,
                   exists (
                       select 1 from applications a
                       where a.user_id = u.id
                         and a.created_at >= (select min(b.created_at) from applications b where b.user_id = u.id) + interval '7 days'
                   ) as came_back
            from users u
            left join profiles p on p.user_id = u.id
            where u.email not like '%@example.com'
              and u.email not like '%@diligently.local'
              and u.created_at >= date_trunc('week', now()) - make_interval(weeks => $1 - 1)
        )
        select week,
               count(*) as signed_up,
               count(*) filter (where verified) as verified,
               count(*) filter (where cv) as cv,
               count(*) filter (where started) as started,
               count(*) filter (where tailored) as tailored,
               count(*) filter (where downloaded) as downloaded,
               count(*) filter (where sent) as sent,
               count(*) filter (where followed_up) as followed_up,
               count(*) filter (where came_back) as came_back
        from people
        group by week
        order by week
        "#,
    )
    .bind(weeks)
    .bind(FILES_DOWNLOADED)
    .fetch_all(db)
    .await?;

    let (to_first_tailored_min, tailoring_secs): (Option<f64>, Option<f64>) = sqlx::query_as(
        r#"
        with people as (
            select u.id, u.created_at from users u
            where u.email not like '%@example.com'
              and u.email not like '%@diligently.local'
              and u.created_at >= date_trunc('week', now()) - make_interval(weeks => $1 - 1)
        )
        select
            (select percentile_cont(0.5) within group (order by extract(epoch from first - p.created_at) / 60)
             from people p
             cross join lateral (
                 select min(e.created_at) as first from events e
                 where e.user_id = p.id and e.kind = 'pipeline_done'
             ) t
             where t.first is not null),
            (select percentile_cont(0.5) within group (order by extract(epoch from j.completed_at - j.started_at))
             from jobs j join people p on p.id = j.user_id
             where j.kind = $2 and j.status = 'done' and j.started_at is not null and j.completed_at is not null)
        "#,
    )
    .bind(weeks)
    .bind(crate::pipeline::KIND)
    .fetch_one(db)
    .await?;

    Ok(Report {
        weeks,
        cohorts,
        to_first_tailored_min,
        tailoring_secs,
    })
}

/// The report as a plain-text table: one row per sign-up week, then a total
/// with each step as a share of sign-ups and of the step before it.
pub fn render(r: &Report) -> String {
    let mut out = String::new();
    let label_w = 13;
    let col_w = 12;
    out.push_str(&format!(
        "Funnel, sign-ups in the last {} week{} (test accounts left out)\n\n",
        r.weeks,
        if r.weeks == 1 { "" } else { "s" }
    ));
    if r.cohorts.is_empty() {
        out.push_str("No sign-ups in this window.\n");
        return out;
    }
    out.push_str(&format!("{:<label_w$}", "step"));
    for c in &r.cohorts {
        out.push_str(&format!(
            "{:>col_w$}",
            c.week.format("wk %d %b").to_string()
        ));
    }
    out.push_str(&format!(
        "{:>col_w$}{:>9}{:>9}\n",
        "total", "of all", "of prev"
    ));

    let total = r.total();
    for (i, step) in STEPS.iter().enumerate() {
        out.push_str(&format!("{step:<label_w$}"));
        for c in &r.cohorts {
            out.push_str(&format!("{:>col_w$}", c.steps()[i]));
        }
        let of_all = pct(total[i], total[0]);
        let of_prev = if i == 0 {
            String::new()
        } else {
            pct(total[i], total[i - 1])
        };
        out.push_str(&format!("{:>col_w$}{of_all:>9}{of_prev:>9}\n", total[i]));
    }

    out.push('\n');
    out.push_str(&format!(
        "Median time from sign-up to first tailored CV: {}\n",
        r.to_first_tailored_min
            .map(minutes)
            .unwrap_or_else(|| "none yet".into())
    ));
    out.push_str(&format!(
        "Median tailoring run: {}\n",
        r.tailoring_secs
            .map(|s| format!("{:.0}s", s))
            .unwrap_or_else(|| "none yet".into())
    ));
    out
}

fn pct(n: i64, of: i64) -> String {
    if of == 0 {
        "-".into()
    } else {
        format!("{:.0}%", n as f64 * 100.0 / of as f64)
    }
}

fn minutes(m: f64) -> String {
    if m < 90.0 {
        format!("{m:.0} min")
    } else if m < 60.0 * 48.0 {
        format!("{:.1} h", m / 60.0)
    } else {
        format!("{:.1} days", m / 60.0 / 24.0)
    }
}
