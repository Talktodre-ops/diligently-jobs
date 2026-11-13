//! `diligently-api dev-seed --email <e> --password <p>`: create (or reset) a
//! verified, onboarded account with a sample master CV, so browser tests can
//! sign in through the real form and land on Home.
//!
//! Development only. It refuses any database whose host is not local, so it
//! cannot plant a known password on a hosted database.

use anyhow::{bail, Context, Result};
use sqlx::PgPool;
use uuid::Uuid;

use crate::render::resume::ResumeDoc;
use crate::routes::{cv, profile};

/// Hosts a dev database can live on: this machine, or the compose service.
const LOCAL_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1", "[::1]", "db"];

pub fn ensure_local_database(database_url: &str) -> Result<()> {
    let host = database_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.rsplit_once('@').map(|(_, h)| h).or(Some(rest)))
        .map(|h| h.split(['/', '?']).next().unwrap_or(""))
        .map(|h| {
            if h.starts_with('[') {
                h.split(']')
                    .next()
                    .map(|s| format!("{s}]"))
                    .unwrap_or_default()
            } else {
                h.split(':').next().unwrap_or("").to_string()
            }
        })
        .unwrap_or_default();
    if !LOCAL_HOSTS.contains(&host.as_str()) {
        bail!("dev-seed only runs against a local database, not host `{host}`");
    }
    Ok(())
}

pub async fn seed(db: &PgPool, email: &str, password: &str, full_name: &str) -> Result<Uuid> {
    let email = crate::validate::email("email", email)
        .map_err(|e| anyhow::anyhow!("invalid email: {e:?}"))?;
    let hash = crate::auth::password::hash(password)
        .await
        .map_err(|e| anyhow::anyhow!("hash password: {e:?}"))?;
    let user_id: Uuid = sqlx::query_scalar(
        r#"
        insert into users (email, password_hash, email_verified_at)
        values ($1, $2, now())
        on conflict (lower(email)) do update
            set password_hash = excluded.password_hash,
                email_verified_at = coalesce(users.email_verified_at, now())
        returning id
        "#,
    )
    .bind(&email)
    .bind(&hash)
    .fetch_one(db)
    .await
    .context("upsert user")?;

    profile::ensure(db, user_id)
        .await
        .map_err(|e| anyhow::anyhow!("ensure profile: {e:?}"))?;
    let has_master: bool = sqlx::query_scalar(
        "select master_cv_version_id is not null from profiles where user_id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    if !has_master {
        let doc: ResumeDoc = serde_json::from_value(sample_cv(full_name, &email))?;
        cv::save_master(db, user_id, &doc, "Seeded sample")
            .await
            .map_err(|e| anyhow::anyhow!("save master CV: {e:?}"))?;
    }
    sqlx::query(
        r#"
        update profiles
        set full_name = coalesce(full_name, $2),
            headline = coalesce(headline, 'Senior Backend Engineer'),
            target_roles = case when target_roles = '{}' then array['Senior Backend Engineer'] else target_roles end,
            work_settings = case when work_settings = '{}' then array['remote'] else work_settings end,
            onboarding_step = 'done'
        where user_id = $1
        "#,
    )
    .bind(user_id)
    .bind(full_name)
    .execute(db)
    .await?;
    Ok(user_id)
}

/// A fictional CV. Every number in it is the "source" the AI guards check
/// generated text against, so it is deliberately concrete.
fn sample_cv(name: &str, email: &str) -> serde_json::Value {
    serde_json::json!({
        "header": { "name": name, "title": "Senior Backend Engineer", "email": email, "location": "Lagos" },
        "summary": "Backend engineer with 7 years building payment and ledger systems in Go and Rust.",
        "experience": [
            { "role": "Senior Backend Engineer", "company": "Northfold", "location": "Lagos", "start": "2021", "end": "Present",
              "bullets": [
                "Cut ledger reconciliation time by 60% by moving batch jobs to Kafka consumers in Go",
                "Designed the Postgres partitioning scheme for 400M payment rows",
                "Led a 4-person on-call rotation and wrote the incident runbooks"
              ] },
            { "role": "Backend Engineer", "company": "Quarry Labs", "start": "2018", "end": "2021",
              "bullets": [ "Built the billing API in Rust used by 30 merchant integrations", "Ran Terraform for 3 AWS accounts" ] }
        ],
        "skills": [
            { "label": "Languages", "items": ["Go", "Rust", "SQL"] },
            { "label": "Infra", "items": ["Postgres", "Kafka", "Kubernetes", "Terraform"] }
        ],
        "education": [{ "institution": "University of Lagos", "degree": "B.Sc. Computer Science" }]
    })
}

#[cfg(test)]
mod tests {
    use super::ensure_local_database as check;

    #[test]
    fn accepts_only_local_hosts() {
        assert!(check("postgres://u:p@db:5432/diligently").is_ok());
        assert!(check("postgres://u:p@127.0.0.1:5439/x").is_ok());
        assert!(check("postgresql://localhost/x").is_ok());
        assert!(check("postgres://u:p@[::1]:5432/x").is_ok());
        assert!(check(
            "postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require"
        )
        .is_err());
        assert!(check("postgres://u:p@db.example.com/x").is_err());
        assert!(check("postgres://u:p@dbx:5432/x").is_err());
    }
}
