//! Job kind dispatch.
//!
//! Each `kind` is a string the producer set when enqueueing; this module is
//! the single place that knows how to actually run them.

use anyhow::{anyhow, Context};
use serde_json::{json, Value};
use uuid::Uuid;

use super::Job;
use crate::llm::Llm;
use crate::render;
use crate::AppState;

pub const KIND_CV_RENDER: &str = "cv_render";
pub const KIND_COVER_LETTER_RENDER: &str = "cover_letter_render";
pub const KIND_ATS_SCORE: &str = "ats_score";

/// Run the handler for a job. Errors bubble up to the worker, which marks the
/// row failed (with retry/backoff per `mark_failed`). Successful return value
/// is stored on `jobs.result` for the client to read via GET /v1/jobs/:id.
pub async fn dispatch(state: &AppState, job: &Job) -> anyhow::Result<Value> {
    match job.kind.as_str() {
        KIND_CV_RENDER => cv_render(state, &job.payload).await,
        KIND_COVER_LETTER_RENDER => cover_letter_render(state, &job.payload).await,
        KIND_ATS_SCORE => ats_score(state, &job.payload).await,
        other => Err(anyhow!("unknown job kind: {other}")),
    }
}

/// Payload: { "cover_letter_id": "<uuid>" }
///
/// Output: { "pdf_key": "...", "docx_key": "...", "cover_letter_id": "..." }
async fn cover_letter_render(state: &AppState, payload: &Value) -> anyhow::Result<Value> {
    let cover_letter_id = payload
        .get("cover_letter_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("cover_letter_render payload missing cover_letter_id"))?;
    let cover_letter_id: Uuid = cover_letter_id
        .parse()
        .context("cover_letter_render payload cover_letter_id is not a valid uuid")?;

    let row = sqlx::query_as::<_, render::CoverLetterRow>(
        r#"
        select application_id, doc
        from cover_letters
        where id = $1
        "#,
    )
    .bind(cover_letter_id)
    .fetch_optional(&state.db)
    .await
    .context("load cover_letter")?
    .ok_or_else(|| anyhow!("cover_letter {cover_letter_id} not found"))?;

    let doc_json = row
        .doc
        .ok_or_else(|| anyhow!("cover_letter {cover_letter_id} has no structured doc to render"))?;
    let doc = render::parse_cover_letter_doc(&doc_json).context("parse cover_letter doc")?;

    let pdf_bytes = render::latex::render_cover_letter(&doc)
        .await
        .context("latex render_cover_letter failed")?;
    let docx_bytes =
        render::docx::render_cover_letter_docx(&doc).context("docx render_cover_letter failed")?;

    // `letters/` is the whitelisted prefix in routes::blobs (presign rejects
    // anything else, e.g. the old `cover-letters/`).
    let pdf_key = format!("letters/{cover_letter_id}.pdf");
    let docx_key = format!("letters/{cover_letter_id}.docx");

    state
        .r2
        .put(&pdf_key, pdf_bytes, "application/pdf")
        .await
        .context("R2 PUT cover letter pdf")?;
    state
        .r2
        .put(
            &docx_key,
            docx_bytes,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .await
        .context("R2 PUT cover letter docx")?;

    sqlx::query(
        r#"
        update cover_letters
        set r2_pdf_key = $2,
            r2_docx_key = $3
        where id = $1
        "#,
    )
    .bind(cover_letter_id)
    .bind(&pdf_key)
    .bind(&docx_key)
    .execute(&state.db)
    .await
    .context("update cover_letters render keys")?;

    sqlx::query(
        r#"
        insert into events (kind, payload, application_id)
        values ('cover_letter_rendered', $1, $2)
        "#,
    )
    .bind(json!({
        "cover_letter_id": cover_letter_id,
        "pdf_key": pdf_key,
        "docx_key": docx_key,
    }))
    .bind(row.application_id)
    .execute(&state.db)
    .await
    .context("append cover_letter_rendered event")?;

    Ok(json!({
        "cover_letter_id": cover_letter_id,
        "pdf_key": pdf_key,
        "docx_key": docx_key,
    }))
}

/// Candidate header (name + contacts) from the most recent structured base CV,
/// for the flat fallback which has no header of its own. None if none exists.
async fn latest_base_header(db: &sqlx::PgPool) -> Option<render::resume::Header> {
    let rows = sqlx::query_scalar::<_, Value>(
        "select sections from cv_versions where application_id is null order by created_at desc limit 50",
    )
    .fetch_all(db)
    .await
    .ok()?;
    rows.iter()
        .find_map(|s| render::resume::parse_resume_doc(s).map(|doc| doc.header))
}

/// Payload: { "cv_version_id": "<uuid>" }
///
/// Output: { "pdf_key": "...", "docx_key": "...", "cv_version_id": "..." }
async fn cv_render(state: &AppState, payload: &Value) -> anyhow::Result<Value> {
    let cv_version_id = payload
        .get("cv_version_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("cv_render payload missing cv_version_id"))?;
    let cv_version_id: Uuid = cv_version_id
        .parse()
        .context("cv_render payload cv_version_id is not a valid uuid")?;

    // Load the CV row + (if present) the application it's tied to. The render
    // template wants both for header context.
    let cv = sqlx::query_as::<_, render::CvVersionRow>(
        r#"
        select application_id, sections, label
        from cv_versions
        where id = $1
        "#,
    )
    .bind(cv_version_id)
    .fetch_optional(&state.db)
    .await
    .context("load cv_version")?
    .ok_or_else(|| anyhow!("cv_version {cv_version_id} not found"))?;

    let app: Option<render::ApplicationContext> = if let Some(app_id) = cv.application_id {
        sqlx::query_as::<_, render::ApplicationContext>(
            r#"
            select company, role
            from applications
            where id = $1
            "#,
        )
        .bind(app_id)
        .fetch_optional(&state.db)
        .await
        .context("load application context")?
    } else {
        None
    };

    // Templated path when `cv.sections` parses as a `ResumeDoc`; flat path
    // otherwise.
    let resume_doc = render::resume::parse_resume_doc(&cv.sections);

    let (pdf_bytes, docx_bytes) = match &resume_doc {
        Some(doc) => {
            tracing::info!(cv_version_id = %cv_version_id, "rendering cv via templated path (ResumeDoc)");
            let pdf = render::latex::render_cv(doc)
                .await
                .context("latex render_cv failed")?;
            let docx = render::docx::render_resume_doc(doc)
                .context("docx render_resume_doc failed")?;
            (pdf, docx)
        }
        None => {
            // Flat sections: render their real content, borrowing the header
            // (name + contacts) from the latest structured base CV.
            tracing::info!(cv_version_id = %cv_version_id, "rendering cv via flat-sections path (no structured ResumeDoc)");
            let base_header = latest_base_header(&state.db).await;
            let pdf = render::latex::render_flat_cv(&cv.sections, app.as_ref(), base_header.as_ref())
                .await
                .context("latex render_flat_cv failed")?;
            let docx = render::docx::render_cv(&cv, app.as_ref())
                .context("docx render failed")?;
            (pdf, docx)
        }
    };

    let pdf_key = format!("cvs/{cv_version_id}.pdf");
    let docx_key = format!("cvs/{cv_version_id}.docx");

    state
        .r2
        .put(&pdf_key, pdf_bytes, "application/pdf")
        .await
        .context("R2 PUT pdf")?;
    state
        .r2
        .put(
            &docx_key,
            docx_bytes,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .await
        .context("R2 PUT docx")?;

    sqlx::query(
        r#"
        update cv_versions
        set r2_pdf_key = $2,
            r2_docx_key = $3
        where id = $1
        "#,
    )
    .bind(cv_version_id)
    .bind(&pdf_key)
    .bind(&docx_key)
    .execute(&state.db)
    .await
    .context("update cv_versions render keys")?;

    // Mirror the latest render keys onto the application row so a single
    // SELECT on applications yields the JD + the latest rendered CV bundle.
    // cv_versions stays the immutable history; this is the latest pointer.
    if let Some(app_id) = cv.application_id {
        sqlx::query(
            r#"
            update applications
            set latest_cv_version_id  = $2,
                latest_cv_pdf_key     = $3,
                latest_cv_docx_key    = $4,
                latest_cv_rendered_at = now()
            where id = $1
            "#,
        )
        .bind(app_id)
        .bind(cv_version_id)
        .bind(&pdf_key)
        .bind(&docx_key)
        .execute(&state.db)
        .await
        .context("update applications latest_cv_*")?;
    }

    // Audit log.
    sqlx::query(
        r#"
        insert into events (kind, payload, application_id)
        values ('cv_rendered', $1, $2)
        "#,
    )
    .bind(json!({
        "cv_version_id": cv_version_id,
        "pdf_key": pdf_key,
        "docx_key": docx_key,
    }))
    .bind(cv.application_id)
    .execute(&state.db)
    .await
    .context("append cv_rendered event")?;

    Ok(json!({
        "cv_version_id": cv_version_id,
        "pdf_key": pdf_key,
        "docx_key": docx_key,
    }))
}

const ATS_SYSTEM_PROMPT: &str = r#"You are an ATS (applicant tracking system) résumé scorer. Compare a candidate's CV against a specific job and return how well the CV would pass an ATS keyword/skills match for THIS job.

Score 0–100 reflecting: coverage of the job's required skills/keywords, alignment of relevant experience, and presence of standard résumé sections. Be strict and consistent — a generic CV with few of the job's keywords scores low; a closely-matched one scores high.

Output ONLY a JSON object with this exact shape (no markdown, no prose):
{
  "score": 0-100 integer,
  "matched_keywords": ["keywords/skills from the job that ARE evidenced in the CV"],
  "missing_keywords": ["required keywords/skills from the job NOT found in the CV"],
  "sections": [{ "name": "Summary|Experience|Skills|Education|Projects", "present": true|false }],
  "notes": "one or two sentences on the biggest gaps to close"
}"#;

/// Recursively collect non-empty string values from a jsonb value — flattens
/// either the flat `CVSection[]` shape or a structured `ResumeDoc` into text
/// without needing to know the exact schema.
fn collect_strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_strings(x, out)),
        Value::Object(o) => o.values().for_each(|x| collect_strings(x, out)),
        _ => {}
    }
}

/// UTF-8-safe truncation to at most `max` bytes.
fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Parse a JSON object from model output; tolerate stray prose by slicing from
/// the first `{` to the last `}` if a direct parse fails.
fn extract_json_object(s: &str) -> anyhow::Result<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return Ok(v);
    }
    if let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) {
        if b > a {
            return Ok(serde_json::from_str::<Value>(&s[a..=b])?);
        }
    }
    Err(anyhow!("no JSON object found in model output"))
}

/// Payload: { "application_id": "<uuid>" }
///
/// Scores the application's most relevant CV (latest tailored for the app, else
/// the latest base CV) against the JD via the LLM, stores an `ats_scores` row,
/// and emits an `ats_scored` event.
/// Output: { "ats_score_id": "...", "cv_version_id": "...", "score": n }
async fn ats_score(state: &AppState, payload: &Value) -> anyhow::Result<Value> {
    let application_id = payload
        .get("application_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("ats_score payload missing application_id"))?;
    let application_id: Uuid = application_id
        .parse()
        .context("ats_score application_id is not a valid uuid")?;

    let (jd_raw, requirements, role, _company) =
        sqlx::query_as::<_, (String, Option<Value>, Option<String>, Option<String>)>(
            "select jd_raw, requirements, role, company from applications where id = $1",
        )
        .bind(application_id)
        .fetch_optional(&state.db)
        .await
        .context("load application")?
        .ok_or_else(|| anyhow!("application {application_id} not found"))?;

    // Prefer the latest CV tied to this application; fall back to the latest base CV.
    let cv = match sqlx::query_as::<_, (Uuid, Value)>(
        "select id, sections from cv_versions where application_id = $1 order by created_at desc limit 1",
    )
    .bind(application_id)
    .fetch_optional(&state.db)
    .await
    .context("load tailored cv")?
    {
        Some(c) => Some(c),
        None => sqlx::query_as::<_, (Uuid, Value)>(
            "select id, sections from cv_versions where application_id is null order by created_at desc limit 1",
        )
        .fetch_optional(&state.db)
        .await
        .context("load base cv")?,
    };
    let (cv_id, sections) =
        cv.ok_or_else(|| anyhow!("no CV found to score — upload or tailor a CV first"))?;

    let mut parts: Vec<String> = Vec::new();
    collect_strings(&sections, &mut parts);
    let cv_text = truncate_str(&parts.join("\n"), 6000);

    let mut jd = String::new();
    if let Some(req) = &requirements {
        if let Some(arr) = req.get("required").and_then(Value::as_array) {
            let v: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
            if !v.is_empty() {
                jd.push_str(&format!("REQUIRED: {}\n", v.join(", ")));
            }
        }
        if let Some(arr) = req.get("keywords").and_then(Value::as_array) {
            let v: Vec<&str> = arr.iter().filter_map(Value::as_str).collect();
            if !v.is_empty() {
                jd.push_str(&format!("KEYWORDS: {}\n", v.join(", ")));
            }
        }
    }
    jd.push_str("\nJOB DESCRIPTION:\n");
    jd.push_str(&truncate_str(&jd_raw, 4000));

    let user_msg = format!(
        "TARGET ROLE: {}\n{}\n\nCANDIDATE CV:\n{}",
        role.unwrap_or_default(),
        jd,
        if cv_text.trim().is_empty() {
            "(empty CV)"
        } else {
            cv_text.as_str()
        }
    );

    let llm = Llm::from_env()?;
    let content = llm
        .chat_json(ATS_SYSTEM_PROMPT, &user_msg)
        .await
        .context("ATS LLM scoring call failed")?;
    let parsed = extract_json_object(&content).context("ATS LLM output was not valid JSON")?;

    let score = parsed
        .get("score")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 100) as i32;
    let breakdown = json!({
        "matched_keywords": parsed.get("matched_keywords").cloned().unwrap_or_else(|| json!([])),
        "missing_keywords": parsed.get("missing_keywords").cloned().unwrap_or_else(|| json!([])),
        "sections": parsed.get("sections").cloned().unwrap_or_else(|| json!([])),
        "notes": parsed.get("notes").cloned().unwrap_or(Value::Null),
    });

    let ats_id: Uuid = sqlx::query_scalar(
        "insert into ats_scores (application_id, cv_version_id, score, breakdown) values ($1, $2, $3, $4) returning id",
    )
    .bind(application_id)
    .bind(cv_id)
    .bind(score)
    .bind(&breakdown)
    .fetch_one(&state.db)
    .await
    .context("insert ats_score")?;

    sqlx::query("insert into events (kind, payload, application_id) values ('ats_scored', $1, $2)")
        .bind(json!({ "score": score, "cv_version_id": cv_id }))
        .bind(application_id)
        .execute(&state.db)
        .await
        .context("append ats_scored event")?;

    Ok(json!({
        "ats_score_id": ats_id,
        "cv_version_id": cv_id,
        "score": score,
    }))
}
