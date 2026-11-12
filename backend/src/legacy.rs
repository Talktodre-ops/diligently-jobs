//! Move desktop-era data from the placeholder legacy owner to a real account.
//!
//! The tenancy migration assigns pre-existing rows to
//! `legacy@diligently.local`, which has no password. Once the real owner has
//! signed up, `diligently-api claim-legacy --email <their email>` moves every
//! row to that account in one transaction and deletes the placeholder.

use anyhow::{anyhow, bail, Context, Result};
use sqlx::PgPool;
use uuid::Uuid;

pub const LEGACY_EMAIL: &str = "legacy@diligently.local";

/// Every table with a user_id. Parents come first: re-pointing an application
/// (or a CV) cascades through the composite foreign keys to the rows hanging
/// off it, and the later updates pick up whatever is left.
const OWNED_TABLES: &[&str] = &[
    "applications",
    "cv_versions",
    "events",
    "gap_analyses",
    "tailored_bullets",
    "cover_letters",
    "interviews",
    "chat_conversations",
    "jobs",
    "company_research",
    "proposals",
    "ats_scores",
];

#[derive(Debug, Default)]
pub struct ClaimReport {
    pub moved: Vec<(&'static str, u64)>,
}

impl ClaimReport {
    pub fn total(&self) -> u64 {
        self.moved.iter().map(|(_, n)| n).sum()
    }
}

pub async fn claim(db: &PgPool, target_email: &str) -> Result<ClaimReport> {
    let target_email = target_email.trim().to_lowercase();
    if target_email == LEGACY_EMAIL {
        bail!("the target must be a real account, not the legacy placeholder");
    }
    let mut tx = db.begin().await?;

    let legacy: Option<Uuid> = sqlx::query_scalar("select id from users where lower(email) = $1")
        .bind(LEGACY_EMAIL)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(legacy) = legacy else {
        return Ok(ClaimReport::default());
    };

    let target: Option<(Uuid, Option<String>)> =
        sqlx::query_as("select id, password_hash from users where lower(email) = $1")
            .bind(&target_email)
            .fetch_optional(&mut *tx)
            .await?;
    let (target, hash) =
        target.ok_or_else(|| anyhow!("no account for {target_email}; sign up first"))?;
    if hash.is_none() {
        bail!("{target_email} has no password set and cannot receive data");
    }

    // Count first: cascades mean later updates touch fewer rows than moved.
    let mut report = ClaimReport::default();
    for table in OWNED_TABLES {
        let n: i64 =
            sqlx::query_scalar(&format!("select count(*) from {table} where user_id = $1"))
                .bind(legacy)
                .fetch_one(&mut *tx)
                .await?;
        report.moved.push((table, n as u64));
    }
    for table in OWNED_TABLES {
        sqlx::query(&format!(
            "update {table} set user_id = $1 where user_id = $2"
        ))
        .bind(target)
        .bind(legacy)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("move rows in {table}"))?;
    }
    sqlx::query("delete from users where id = $1")
        .bind(legacy)
        .execute(&mut *tx)
        .await?;
    tx.commit().await.context("commit claim")?;
    Ok(report)
}
