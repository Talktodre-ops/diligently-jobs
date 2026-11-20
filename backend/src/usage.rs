//! Metering and limits for AI work.
//!
//! Every AI call goes through `call`, which refuses when AI is switched off,
//! when the platform has spent its daily cap, or when the user is calling too
//! fast, then records tokens and cost in `ai_usage`. Plans limit how many
//! applications a user can start per calendar month (UTC).

use std::collections::HashMap;

use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::ai::{LlmRequest, LlmResponse, Usage};
use crate::error::AppError;
use crate::rate_limit;
use crate::AppState;

#[derive(Debug, Clone)]
pub struct LimitsConfig {
    /// AI_DISABLED: turn every AI call off without a deploy.
    pub ai_disabled: bool,
    /// AI_DAILY_SPEND_CAP_USD in micro-dollars; 0 means no cap.
    pub daily_cap_micros: i64,
    /// PLAN_LIMITS, e.g. `free:10,pro:200`: applications per month per plan.
    pub plan_limits: HashMap<String, i64>,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            ai_disabled: false,
            daily_cap_micros: 20_000_000,
            plan_limits: HashMap::from([("free".to_string(), 10)]),
        }
    }
}

impl LimitsConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let mut c = Self::default();
        if let Ok(v) = std::env::var("AI_DISABLED") {
            c.ai_disabled = matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes");
        }
        if let Ok(v) = std::env::var("AI_DAILY_SPEND_CAP_USD") {
            if !v.trim().is_empty() {
                let usd: f64 = v
                    .trim()
                    .parse()
                    .map_err(|_| anyhow::anyhow!("AI_DAILY_SPEND_CAP_USD must be a number"))?;
                if usd < 0.0 {
                    anyhow::bail!("AI_DAILY_SPEND_CAP_USD cannot be negative");
                }
                c.daily_cap_micros = (usd * 1_000_000.0).round() as i64;
            }
        }
        if let Ok(v) = std::env::var("PLAN_LIMITS") {
            if !v.trim().is_empty() {
                c.plan_limits = parse_plan_limits(&v)?;
            }
        }
        if !c.plan_limits.contains_key("free") {
            anyhow::bail!("PLAN_LIMITS must include the free plan, e.g. free:10");
        }
        Ok(c)
    }

    /// Unknown plans get the free limit rather than none.
    pub fn monthly_limit(&self, plan: &str) -> i64 {
        self.plan_limits
            .get(plan)
            .or_else(|| self.plan_limits.get("free"))
            .copied()
            .unwrap_or(0)
    }
}

pub fn parse_plan_limits(s: &str) -> anyhow::Result<HashMap<String, i64>> {
    let mut out = HashMap::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (name, n) = part
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("PLAN_LIMITS entry `{part}` must be name:number"))?;
        let n: i64 = n
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("PLAN_LIMITS entry `{part}` needs a whole number"))?;
        out.insert(name.trim().to_lowercase(), n);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/// Micro-dollars per million tokens: (input, output, cache read, cache write).
/// Source: Anthropic first-party list prices as recorded in the claude-api
/// skill's model table (cached 2026-11-03). Cache writes are not used by these
/// prompts; priced at 1.25x input as a conservative stand-in. Recheck the
/// public pricing page before relying on these numbers for billing.
fn price(model: &str) -> (i64, i64, i64, i64) {
    if model.starts_with("claude-sonnet-5-5") {
        (2_000_000, 10_000_000, 100_000, 2_500_000)
    } else if model.starts_with("claude-haiku-5-5") {
        (100_000, 500_000, 10_000, 125_000)
    } else if model.starts_with("claude-opus-5-5") {
        (4_000_000, 20_000_000, 200_000, 5_000_000)
    } else {
        // Unknown or fallback model (for example claude-opus-5 or 4-8):
        // price at the higher Opus 5 list rate so spend is not understated.
        (5_000_000, 25_000_000, 500_000, 6_250_000)
    }
}

pub fn cost_micros(model: &str, u: &Usage) -> i64 {
    let (pi, po, pr, pw) = price(model);
    (u.input_tokens * pi
        + u.output_tokens * po
        + u.cache_read_input_tokens * pr
        + u.cache_creation_input_tokens * pw)
        / 1_000_000
}

// ---------------------------------------------------------------------------
// The gate every AI call goes through
// ---------------------------------------------------------------------------

fn start_of_today() -> DateTime<Utc> {
    let now = Utc::now();
    Utc.from_utc_datetime(&now.date_naive().and_hms_opt(0, 0, 0).expect("midnight"))
}

pub async fn platform_spend_today(db: &PgPool) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "select coalesce(sum(cost_micros), 0)::bigint from ai_usage where created_at >= $1",
    )
    .bind(start_of_today())
    .fetch_one(db)
    .await?)
}

/// Run one metered AI call for `user_id`.
pub async fn call(
    state: &AppState,
    user_id: Uuid,
    application_id: Option<Uuid>,
    req: LlmRequest,
) -> Result<LlmResponse, AppError> {
    let limits = &state.config.limits;
    if limits.ai_disabled {
        return Err(AppError::unavailable(
            "ai_unavailable",
            "AI features are paused right now. Try again later.",
        ));
    }
    if limits.daily_cap_micros > 0
        && platform_spend_today(&state.db).await? >= limits.daily_cap_micros
    {
        tracing::error!(
            "ai: daily platform spend cap reached; refusing AI calls until midnight UTC"
        );
        return Err(AppError::unavailable(
            "ai_unavailable",
            "AI features are busy right now. Try again later.",
        ));
    }
    state
        .limiter
        .check(rate_limit::AI_USER, &user_id.to_string())?;

    let task = req.task;
    let res = state.ai.complete(req).await?;
    let cost = cost_micros(&res.model, &res.usage);
    sqlx::query(
        r#"
        insert into ai_usage (user_id, task, model, input_tokens, output_tokens,
                              cache_read_tokens, cache_write_tokens, cost_micros, application_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
    )
    .bind(user_id)
    .bind(task)
    .bind(&res.model)
    .bind(res.usage.input_tokens)
    .bind(res.usage.output_tokens)
    .bind(res.usage.cache_read_input_tokens)
    .bind(res.usage.cache_creation_input_tokens)
    .bind(cost)
    .bind(application_id)
    .execute(&state.db)
    .await?;
    Ok(res)
}

// ---------------------------------------------------------------------------
// Monthly application allowance
// ---------------------------------------------------------------------------

pub fn month_bounds(now: DateTime<Utc>) -> (DateTime<Utc>, NaiveDate) {
    let first = NaiveDate::from_ymd_opt(now.year(), now.month(), 1).expect("first of month");
    let next = if now.month() == 12 {
        NaiveDate::from_ymd_opt(now.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(now.year(), now.month() + 1, 1)
    }
    .expect("first of next month");
    (
        Utc.from_utc_datetime(&first.and_hms_opt(0, 0, 0).expect("midnight")),
        next,
    )
}

pub async fn applications_this_month(db: &PgPool, user_id: Uuid) -> Result<i64, AppError> {
    let (start, _) = month_bounds(Utc::now());
    Ok(sqlx::query_scalar::<_, i64>(
        "select count(*) from applications where user_id = $1 and created_at >= $2",
    )
    .bind(user_id)
    .bind(start)
    .fetch_one(db)
    .await?)
}

/// 422 plan_limit_reached when the user has used this month's allowance.
pub async fn ensure_can_start_application(
    state: &AppState,
    user_id: Uuid,
    plan: &str,
) -> Result<(), AppError> {
    let limit = state.config.limits.monthly_limit(plan);
    if applications_this_month(&state.db, user_id).await? >= limit {
        return Err(AppError::unprocessable(
            "plan_limit_reached",
            format!("You have used all {limit} applications for this month."),
        ));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct UsageOut {
    pub plan: String,
    pub applications_this_month: i64,
    pub monthly_limit: i64,
    pub resets_on: NaiveDate,
}

/// GET /v1/usage for the Settings screen.
pub async fn get(
    axum::extract::State(state): axum::extract::State<AppState>,
    user: crate::auth::CurrentUser,
) -> Result<crate::extract::Json<UsageOut>, AppError> {
    let (_, resets_on) = month_bounds(Utc::now());
    Ok(crate::extract::Json(UsageOut {
        applications_this_month: applications_this_month(&state.db, user.id).await?,
        monthly_limit: state.config.limits.monthly_limit(&user.plan),
        plan: user.plan,
        resets_on,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_is_computed_in_micro_dollars() {
        let u = Usage {
            input_tokens: 10_000,
            output_tokens: 2_000,
            ..Usage::default()
        };
        // Sonnet 5.5: 10k * $2/M + 2k * $10/M = $0.02 + $0.02
        assert_eq!(cost_micros("claude-sonnet-5-5", &u), 40_000);
        // Unknown models are priced high, not free.
        assert!(cost_micros("claude-opus-4-8", &u) > cost_micros("claude-opus-5-5", &u));
    }

    #[test]
    fn plan_limits_parse_and_fall_back_to_free() {
        let m = parse_plan_limits("free:10, Pro:200").unwrap();
        assert_eq!(m["pro"], 200);
        assert!(parse_plan_limits("free").is_err());
        assert!(parse_plan_limits("free:ten").is_err());
        let c = LimitsConfig {
            plan_limits: m,
            ..LimitsConfig::default()
        };
        assert_eq!(c.monthly_limit("mystery"), 10);
    }

    #[test]
    fn month_bounds_roll_over_december() {
        let dec = Utc.with_ymd_and_hms(2026, 12, 15, 10, 0, 0).unwrap();
        let (start, next) = month_bounds(dec);
        assert_eq!(start.to_rfc3339(), "2026-12-01T00:00:00+00:00");
        assert_eq!(next.to_string(), "2027-01-01");
    }
}
