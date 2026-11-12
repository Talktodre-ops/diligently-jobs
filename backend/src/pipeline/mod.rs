//! The application pipeline behind New job and Running: read the job,
//! compare it with the CV, rewrite bullets, research the company, draft the
//! letter. Each step checks whether its output already exists and skips if
//! so, which makes a retried job safe and keeps a finished step from being
//! paid for twice. Steps record their status in `jobs.progress`.

pub mod compose;

use anyhow::{anyhow, Context};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;
use crate::jobs::Job;
use crate::prompts::{self, ats_score, cover_letter, gaps, jd_analysis, research, rewrites};
use crate::render::resume::{self, ResumeDoc};
use crate::render::CoverLetterDoc;
use crate::web::WebError;
use crate::AppState;
use compose::{compose, AddedBullet, BulletChange};

pub const KIND: &str = "application_pipeline";

/// (key, label shown on the Running screen)
pub const STEPS: &[(&str, &str)] = &[
    ("read_job", "Reading the job"),
    ("compare", "Comparing it with your CV"),
    ("rewrite", "Rewriting your strongest bullets"),
    ("research", "Researching the company"),
    ("letter", "Drafting your cover letter"),
];

pub fn initial_progress(research: bool, letter: bool) -> Value {
    Value::Array(
        STEPS
            .iter()
            .map(|(key, label)| {
                let skipped = (*key == "research" && !research) || (*key == "letter" && !letter);
                json!({ "key": key, "label": label, "status": if skipped { "skipped" } else { "pending" } })
            })
            .collect(),
    )
}

async fn set_step(db: &PgPool, job_id: Uuid, key: &str, status: &str) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        update jobs set progress = (
            select jsonb_agg(case when e->>'key' = $2 then jsonb_set(e, '{status}', to_jsonb($3::text)) else e end
                             order by ord)
            from jsonb_array_elements(progress) with ordinality as t(e, ord)
        )
        where id = $1
        "#,
    )
    .bind(job_id)
    .bind(key)
    .bind(status)
    .execute(db)
    .await
    .context("update job progress")?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct AppRow {
    jd_raw: String,
    source_url: Option<String>,
    jd_analysis: Option<Value>,
    base_cv_version_id: Option<Uuid>,
    options: Value,
    company: Option<String>,
    role: Option<String>,
}

async fn load_app(db: &PgPool, uid: Uuid, app_id: Uuid) -> anyhow::Result<AppRow> {
    sqlx::query_as::<_, AppRow>(
        "select jd_raw, source_url, jd_analysis, base_cv_version_id, options, company, role from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("application {app_id} not found"))
}

/// The master CV version an application started from.
pub async fn base_doc(db: &PgPool, uid: Uuid, cv_id: Option<Uuid>) -> anyhow::Result<ResumeDoc> {
    let cv_id = cv_id.ok_or_else(|| anyhow!("application has no base CV"))?;
    let sections: Value =
        sqlx::query_scalar("select sections from cv_versions where id = $1 and user_id = $2")
            .bind(cv_id)
            .bind(uid)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| anyhow!("base CV {cv_id} not found"))?;
    resume::parse_resume_doc(&sections).ok_or_else(|| anyhow!("base CV is in the legacy format"))
}

async fn exists(db: &PgPool, sql: &str, app_id: Uuid) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(sql)
        .bind(app_id)
        .fetch_one(db)
        .await?)
}

fn ai(e: AppError) -> anyhow::Error {
    anyhow!("{e}")
}

/// Run every step that has not produced its output yet.
pub async fn run(state: &AppState, job: &Job) -> anyhow::Result<Value> {
    let uid = job.user_id;
    let app_id: Uuid = job
        .payload
        .get("application_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("payload missing application_id"))?
        .parse()?;

    for (key, _) in STEPS {
        let app = load_app(&state.db, uid, app_id).await?;
        let wanted = match *key {
            "research" => app
                .options
                .get("research")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            "letter" => app
                .options
                .get("letter")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            _ => true,
        };
        if !wanted {
            continue;
        }
        set_step(&state.db, job.id, key, "running").await?;
        let outcome = match *key {
            "read_job" => read_job(state, uid, app_id, &app).await,
            "compare" => compare(state, uid, app_id, &app).await,
            "rewrite" => rewrite(state, uid, app_id, &app).await,
            "research" => research_step(state, uid, app_id, &app).await,
            _ => letter_step(state, uid, app_id, &app).await,
        };
        match outcome {
            Ok(done) => {
                set_step(
                    &state.db,
                    job.id,
                    key,
                    if done { "done" } else { "skipped" },
                )
                .await?
            }
            Err(e) => {
                set_step(&state.db, job.id, key, "failed").await?;
                return Err(e.context(format!("pipeline step {key}")));
            }
        }
    }
    sqlx::query("insert into events (kind, payload, application_id, user_id) values ('pipeline_done', '{}', $1, $2)")
        .bind(app_id)
        .bind(uid)
        .execute(&state.db)
        .await?;
    Ok(json!({ "application_id": app_id }))
}

/// Get the job text (from the link if needed) and analyse it.
async fn read_job(state: &AppState, uid: Uuid, app_id: Uuid, app: &AppRow) -> anyhow::Result<bool> {
    if app.jd_analysis.is_some() {
        return Ok(true);
    }
    let mut jd = app.jd_raw.clone();
    if jd.trim().is_empty() {
        let url = app
            .source_url
            .as_deref()
            .ok_or_else(|| anyhow!("application has neither text nor a link"))?;
        let page = state.web.extract(url).await.map_err(|e| match e {
            WebError::NotConfigured | WebError::Unreadable(_) => {
                anyhow!("link_unreadable: {e}")
            }
            other => anyhow!("{other}"),
        })?;
        jd = page.content;
    }
    let res = crate::usage::call(state, uid, Some(app_id), jd_analysis::request(&jd))
        .await
        .map_err(ai)?;
    let a = jd_analysis::parse(res.value).map_err(|e| anyhow!("job analysis rejected: {e}"))?;
    sqlx::query(
        r#"
        update applications set jd_raw = $3, jd_analysis = $4,
            role = coalesce(nullif(role, ''), $5), company = coalesce(nullif(company, ''), $6),
            requirements = $7
        where id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .bind(&jd)
    .bind(serde_json::to_value(&a)?)
    .bind(&a.role)
    .bind(&a.company)
    .bind(json!({ "required": a.required, "nice_to_have": a.nice_to_have, "keywords": a.keywords }))
    .execute(&state.db)
    .await?;
    Ok(true)
}

fn analysis(app: &AppRow) -> anyhow::Result<jd_analysis::JdAnalysis> {
    serde_json::from_value(
        app.jd_analysis
            .clone()
            .ok_or_else(|| anyhow!("job not read yet"))?,
    )
    .context("stored job analysis")
}

async fn score(
    state: &AppState,
    uid: Uuid,
    app_id: Uuid,
    doc: &ResumeDoc,
    jd: &str,
) -> anyhow::Result<ats_score::AtsScore> {
    let res = crate::usage::call(
        state,
        uid,
        Some(app_id),
        ats_score::request(&prompts::cv_for_prompt(doc), jd),
    )
    .await
    .map_err(ai)?;
    ats_score::parse(res.value).map_err(|e| anyhow!("score rejected: {e}"))
}

async fn insert_score(
    db: &PgPool,
    uid: Uuid,
    app_id: Uuid,
    cv: Option<Uuid>,
    kind: &str,
    s: &ats_score::AtsScore,
) -> anyhow::Result<()> {
    sqlx::query(
        "insert into ats_scores (application_id, user_id, cv_version_id, score, breakdown, kind) values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(app_id)
    .bind(uid)
    .bind(cv)
    .bind(s.score as i32)
    .bind(json!({ "matched_keywords": s.matched_keywords, "missing_keywords": s.missing_keywords, "notes": s.notes }))
    .bind(kind)
    .execute(db)
    .await?;
    Ok(())
}

/// Score the master CV and list the gaps.
async fn compare(state: &AppState, uid: Uuid, app_id: Uuid, app: &AppRow) -> anyhow::Result<bool> {
    let doc = base_doc(&state.db, uid, app.base_cv_version_id).await?;
    if !exists(
        &state.db,
        "select exists(select 1 from ats_scores where application_id = $1 and kind = 'before')",
        app_id,
    )
    .await?
    {
        let s = score(state, uid, app_id, &doc, &app.jd_raw).await?;
        insert_score(&state.db, uid, app_id, app.base_cv_version_id, "before", &s).await?;
    }
    if !exists(
        &state.db,
        "select exists(select 1 from application_gaps where application_id = $1)",
        app_id,
    )
    .await?
    {
        let a = analysis(app)?;
        let req = gaps::request(
            &prompts::cv_for_prompt(&doc),
            &app.jd_raw,
            &a.required,
            &a.nice_to_have,
        );
        let res = crate::usage::call(state, uid, Some(app_id), req)
            .await
            .map_err(ai)?;
        let list = gaps::parse(res.value, &doc).map_err(|e| anyhow!("gaps rejected: {e}"))?;
        let mut tx = state.db.begin().await?;
        for (i, g) in list.iter().enumerate() {
            sqlx::query(
                r#"
                insert into application_gaps (user_id, application_id, position, requirement, importance, status, evidence, ask)
                values ($1, $2, $3, $4, $5, $6, $7, $8)
                "#,
            )
            .bind(uid)
            .bind(app_id)
            .bind(i as i32)
            .bind(&g.requirement)
            .bind(&g.importance)
            .bind(&g.status)
            .bind(&g.evidence)
            .bind(&g.ask)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }
    Ok(true)
}

/// Propose rewrites and a summary, then score the CV with all of them applied.
async fn rewrite(state: &AppState, uid: Uuid, app_id: Uuid, app: &AppRow) -> anyhow::Result<bool> {
    let doc = base_doc(&state.db, uid, app.base_cv_version_id).await?;
    if !exists(
        &state.db,
        "select exists(select 1 from tailored_bullets where application_id = $1)",
        app_id,
    )
    .await?
    {
        let a = analysis(app)?;
        let req = rewrites::request(&prompts::cv_for_prompt(&doc), &app.jd_raw, &a.keywords);
        let res = crate::usage::call(state, uid, Some(app_id), req)
            .await
            .map_err(ai)?;
        let out =
            rewrites::parse(res.value, &doc).map_err(|e| anyhow!("rewrites rejected: {e}"))?;
        let mut tx = state.db.begin().await?;
        for (i, r) in out.rewrites.iter().enumerate() {
            let original = prompts::bullet_by_id(&doc, &r.bullet_id).unwrap_or_default();
            let section = compose::parse_id(&r.bullet_id)
                .and_then(|(e, _)| doc.experience.get(e))
                .map(|e| e.company.clone())
                .unwrap_or_default();
            sqlx::query(
                r#"
                insert into tailored_bullets (application_id, user_id, section, original, rewrite, bullet_id, why, needs_number, position)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                "#,
            )
            .bind(app_id)
            .bind(uid)
            .bind(section)
            .bind(original)
            .bind(&r.rewrite)
            .bind(&r.bullet_id)
            .bind(&r.why)
            .bind(r.needs_number)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query("update applications set tailored_summary = $3 where id = $1 and user_id = $2")
            .bind(app_id)
            .bind(uid)
            .bind(&out.summary)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    if !exists(
        &state.db,
        "select exists(select 1 from ats_scores where application_id = $1 and kind = 'projected')",
        app_id,
    )
    .await?
    {
        let all = fully_tailored(&state.db, uid, app_id, &doc).await?;
        let s = score(state, uid, app_id, &all, &app.jd_raw).await?;
        insert_score(&state.db, uid, app_id, None, "projected", &s).await?;
    }
    Ok(true)
}

/// The CV as it would be with every proposed rewrite and summary accepted.
async fn fully_tailored(
    db: &PgPool,
    uid: Uuid,
    app_id: Uuid,
    base: &ResumeDoc,
) -> anyhow::Result<ResumeDoc> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select bullet_id, rewrite from tailored_bullets where application_id = $1 and user_id = $2 and bullet_id is not null",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_all(db)
    .await?;
    let summary: Option<String> = sqlx::query_scalar(
        "select tailored_summary from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_one(db)
    .await?;
    let changes: Vec<BulletChange> = rows
        .into_iter()
        .map(|(bullet_id, text)| BulletChange { bullet_id, text })
        .collect();
    Ok(compose(base, &changes, summary.as_deref(), &[]))
}

/// The tailored CV with only the user's decisions applied: accepted or
/// edited rewrites, an accepted summary and accepted gap bullets.
pub async fn decided_doc(
    db: &PgPool,
    uid: Uuid,
    app_id: Uuid,
) -> Result<(ResumeDoc, ResumeDoc), AppError> {
    let base_id: Option<Uuid> = sqlx::query_scalar(
        "select base_cv_version_id from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    let base = base_doc(db, uid, base_id)
        .await
        .map_err(AppError::Internal)?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"
        select bullet_id, coalesce(final_text, rewrite) from tailored_bullets
        where application_id = $1 and user_id = $2 and bullet_id is not null and status in ('accepted', 'edited')
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .fetch_all(db)
    .await?;
    let summary: Option<String> = sqlx::query_scalar(
        "select case when summary_status = 'accepted' then tailored_summary end from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_one(db)
    .await?;
    let added: Vec<(Option<i32>, String)> = sqlx::query_as(
        r#"
        select target_entry, suggested_bullet from application_gaps
        where application_id = $1 and user_id = $2 and bullet_status = 'accepted' and suggested_bullet is not null
        order by position
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .fetch_all(db)
    .await?;
    let changes: Vec<BulletChange> = rows
        .into_iter()
        .map(|(bullet_id, text)| BulletChange { bullet_id, text })
        .collect();
    let added: Vec<AddedBullet> = added
        .into_iter()
        .map(|(entry, text)| AddedBullet {
            entry: entry.unwrap_or(0).max(0) as usize,
            text,
        })
        .collect();
    let decided = compose(&base, &changes, summary.as_deref(), &added);
    Ok((base, decided))
}

/// Company research from web search. Skipped when the company is unknown or
/// search is not configured.
async fn research_step(
    state: &AppState,
    uid: Uuid,
    app_id: Uuid,
    app: &AppRow,
) -> anyhow::Result<bool> {
    if exists(
        &state.db,
        "select exists(select 1 from company_research where application_id = $1)",
        app_id,
    )
    .await?
    {
        return Ok(true);
    }
    let Some(company) = app.company.clone().filter(|c| !c.trim().is_empty()) else {
        return Ok(false);
    };
    let hits = match state
        .web
        .search(&format!("{company} company news products"), 6)
        .await
    {
        Ok(h) => h,
        Err(WebError::NotConfigured) => return Ok(false),
        Err(e) => return Err(anyhow!("{e}")),
    };
    if hits.is_empty() {
        return Ok(false);
    }
    let role = app.role.clone().unwrap_or_default();
    let res = crate::usage::call(
        state,
        uid,
        Some(app_id),
        research::request(&company, &role, &hits),
    )
    .await
    .map_err(ai)?;
    let brief =
        research::parse(res.value, hits.len()).map_err(|e| anyhow!("research rejected: {e}"))?;
    sqlx::query("insert into company_research (application_id, user_id, brief, sources) values ($1, $2, $3, $4)")
        .bind(app_id)
        .bind(uid)
        .bind(serde_json::to_value(&brief)?)
        .bind(serde_json::to_value(&hits)?)
        .execute(&state.db)
        .await?;
    Ok(true)
}

/// The research brief as plain text for the letter prompt and number guard.
pub fn research_text(brief: &Value) -> String {
    let b: research::Brief = match serde_json::from_value(brief.clone()) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    let mut s = String::new();
    if let Some(o) = &b.overview {
        s.push_str(&format!("Overview: {o}\n"));
    }
    for n in &b.recent_news {
        s.push_str(&format!("News: {}\n", n.text));
    }
    for t in &b.talking_points {
        s.push_str(&format!("Point: {}\n", t.text));
    }
    if let Some(w) = &b.why_them {
        s.push_str(&format!("Why them: {w}\n"));
    }
    s
}

/// Write a letter in `tone` and store it as the application's newest letter.
pub async fn write_letter(
    state: &AppState,
    uid: Uuid,
    app_id: Uuid,
    tone: &str,
) -> Result<Uuid, AppError> {
    #[derive(sqlx::FromRow)]
    struct Ctx {
        jd_raw: String,
        company: Option<String>,
    }
    let ctx = sqlx::query_as::<_, Ctx>(
        "select jd_raw, company from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let (_, doc) = decided_doc(&state.db, uid, app_id).await?;
    let brief: Option<Value> = sqlx::query_scalar(
        "select brief from company_research where application_id = $1 and user_id = $2 order by created_at desc limit 1",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(&state.db)
    .await?;
    let research = brief.as_ref().map(research_text).filter(|s| !s.is_empty());
    let notes: Vec<String> = sqlx::query_scalar(
        r#"
        select case when answer = 'dont' then 'Does not have: ' || requirement
                    else 'Has: ' || requirement || ' (' || coalesce(answer_text, '') || ')' end
        from application_gaps where application_id = $1 and user_id = $2 and answer is not null order by position
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .fetch_all(&state.db)
    .await?;
    let company = ctx.company.clone().unwrap_or_else(|| "the company".into());
    let cv_text = prompts::cv_for_prompt(&doc);
    let req = cover_letter::request(&cover_letter::Input {
        tone,
        cv_text: &cv_text,
        jd: &ctx.jd_raw,
        company: &company,
        research: research.as_deref(),
        gap_notes: &notes,
    });
    let res = crate::usage::call(state, uid, Some(app_id), req).await?;
    let sources = format!(
        "{}\n{}\n{}\n{}",
        prompts::cv_plain_text(&doc),
        research.unwrap_or_default(),
        notes.join("\n"),
        ctx.jd_raw
    );
    let letter = cover_letter::parse(res.value, &sources).map_err(|e| {
        tracing::warn!(error = %e, "letter rejected by guard");
        AppError::unavailable("ai_failed", "The letter did not come out right. Try again.")
    })?;
    let contact: Vec<String> = [doc.header.email.clone(), doc.header.phone.clone()]
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .collect();
    let letter_doc = CoverLetterDoc {
        candidate_name: doc.header.name.clone(),
        candidate_contact: (!contact.is_empty()).then(|| contact.join(" | ")),
        date: Some(chrono::Utc::now().format("%-d %B %Y").to_string()),
        company: ctx.company.clone(),
        greeting: Some("Dear Hiring Team,".into()),
        paragraphs: letter.paragraphs.clone(),
        signoff: Some("Kind regards,".into()),
    };
    let id: Uuid = sqlx::query_scalar(
        "insert into cover_letters (application_id, user_id, body, doc, tone) values ($1, $2, $3, $4, $5) returning id",
    )
    .bind(app_id)
    .bind(uid)
    .bind(letter.paragraphs.join("\n\n"))
    .bind(serde_json::to_value(&letter_doc).map_err(anyhow::Error::from)?)
    .bind(tone)
    .fetch_one(&state.db)
    .await?;
    Ok(id)
}

async fn letter_step(
    state: &AppState,
    uid: Uuid,
    app_id: Uuid,
    _app: &AppRow,
) -> anyhow::Result<bool> {
    if exists(
        &state.db,
        "select exists(select 1 from cover_letters where application_id = $1)",
        app_id,
    )
    .await?
    {
        return Ok(true);
    }
    write_letter(state, uid, app_id, "direct")
        .await
        .map_err(ai)?;
    Ok(true)
}

/// Score shown while the user reviews: moves from the master CV's score to
/// the projected score in proportion to the proposals accepted so far.
/// Instant and free; a real rescore is available on demand.
pub fn estimate(before: i64, projected: i64, decided: i64, total: i64) -> i64 {
    if total <= 0 {
        return before;
    }
    let gained = (projected - before) as f64 * decided.clamp(0, total) as f64 / total as f64;
    (before as f64 + gained).round().clamp(0.0, 100.0) as i64
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScoreView {
    pub before: Option<i64>,
    pub projected: Option<i64>,
    pub current: Option<i64>,
    /// The newest real score of a tailored version, if one was requested.
    pub rescored: Option<i64>,
    pub decided: i64,
    pub pending: i64,
}

pub async fn score_view(db: &PgPool, uid: Uuid, app_id: Uuid) -> Result<ScoreView, AppError> {
    let latest = |kind: &'static str| async move {
        sqlx::query_scalar::<_, i32>(
            "select score from ats_scores where application_id = $1 and user_id = $2 and kind = $3 order by created_at desc limit 1",
        )
        .bind(app_id)
        .bind(uid)
        .bind(kind)
        .fetch_optional(db)
        .await
        .map(|o| o.map(i64::from))
    };
    let before = latest("before").await?;
    let projected = latest("projected").await?;
    let rescored = latest("rescore").await?;
    let (accepted, pending, total): (i64, i64, i64) = sqlx::query_as(
        r#"
        select
            (select count(*) from tailored_bullets where application_id = $1 and user_id = $2 and status in ('accepted', 'edited'))
              + (select count(*) from applications where id = $1 and user_id = $2 and tailored_summary is not null and summary_status = 'accepted'),
            (select count(*) from tailored_bullets where application_id = $1 and user_id = $2 and status = 'pending')
              + (select count(*) from applications where id = $1 and user_id = $2 and tailored_summary is not null and summary_status = 'pending'),
            (select count(*) from tailored_bullets where application_id = $1 and user_id = $2)
              + (select count(*) from applications where id = $1 and user_id = $2 and tailored_summary is not null)
        "#,
    )
    .bind(app_id)
    .bind(uid)
    .fetch_one(db)
    .await?;
    let current = match (before, projected) {
        (Some(b), Some(p)) => Some(estimate(b, p, accepted, total)),
        (Some(b), None) => Some(b),
        _ => None,
    };
    Ok(ScoreView {
        before,
        projected,
        current,
        rescored,
        decided: accepted,
        pending,
    })
}

/// Save the decided CV as the application's tailored version, reusing the
/// newest one when nothing changed. Returns its id.
pub async fn materialize(db: &PgPool, uid: Uuid, app_id: Uuid) -> Result<Uuid, AppError> {
    let (_, doc) = decided_doc(db, uid, app_id).await?;
    let sections = serde_json::to_value(&doc).map_err(anyhow::Error::from)?;
    let newest: Option<(Uuid, Value)> = sqlx::query_as(
        "select id, sections from cv_versions where application_id = $1 and user_id = $2 order by created_at desc limit 1",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_optional(db)
    .await?;
    if let Some((id, s)) = newest {
        if s == sections {
            return Ok(id);
        }
    }
    let base: Option<Uuid> = sqlx::query_scalar(
        "select base_cv_version_id from applications where id = $1 and user_id = $2",
    )
    .bind(app_id)
    .bind(uid)
    .fetch_one(db)
    .await?;
    let id: Uuid = sqlx::query_scalar(
        "insert into cv_versions (user_id, application_id, sections, label, based_on_id) values ($1, $2, $3, 'tailored', $4) returning id",
    )
    .bind(uid)
    .bind(app_id)
    .bind(&sections)
    .bind(base)
    .fetch_one(db)
    .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_moves_with_decisions() {
        assert_eq!(estimate(80, 86, 0, 3), 80);
        assert_eq!(estimate(80, 86, 2, 3), 84);
        assert_eq!(estimate(80, 86, 3, 3), 86);
        assert_eq!(estimate(80, 86, 9, 3), 86, "clamped");
        assert_eq!(estimate(80, 86, 0, 0), 80);
    }
}
