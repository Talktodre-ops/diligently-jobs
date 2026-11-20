//! CV preview, Send and Documents: render the tailored CV and letter,
//! hand out short-lived download links, list what the user has made.

use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::extract::{Json, Path, Query};
use crate::jobs::{
    self,
    handlers::{KIND_COVER_LETTER_RENDER, KIND_CV_RENDER},
};
use crate::{pipeline, AppState};

const LINK_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderRequest {
    #[serde(default)]
    pub include_letter: bool,
}

async fn enqueue_once(
    state: &AppState,
    uid: Uuid,
    kind: &str,
    payload: Value,
) -> Result<Uuid, AppError> {
    if let Some(j) = jobs::find_active(&state.db, uid, kind, &payload).await? {
        return Ok(j.id);
    }
    Ok(jobs::enqueue(&state.db, uid, kind, payload, 3).await?.id)
}

/// POST /v1/applications/{id}/render: save the decided CV as a version and
/// render it (PDF and DOCX, in the user's paper size), plus the newest
/// letter when asked.
pub async fn render(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
    Json(req): Json<RenderRequest>,
) -> Result<Response, AppError> {
    let cv_id = pipeline::materialize(&state.db, user.id, app_id).await?;
    let cv_job = enqueue_once(
        &state,
        user.id,
        KIND_CV_RENDER,
        json!({ "cv_version_id": cv_id }),
    )
    .await?;
    let letter_job = if req.include_letter {
        let letter: Option<Uuid> = sqlx::query_scalar(
            "select id from cover_letters where application_id = $1 and user_id = $2 and doc is not null order by generated_at desc limit 1",
        )
        .bind(app_id)
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?;
        let letter = letter.ok_or_else(|| {
            AppError::unprocessable("no_letter", "There is no letter for this job yet.")
        })?;
        Some(
            enqueue_once(
                &state,
                user.id,
                KIND_COVER_LETTER_RENDER,
                json!({ "cover_letter_id": letter }),
            )
            .await?,
        )
    } else {
        None
    };
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "cv_version_id": cv_id, "cv_job_id": cv_job, "letter_job_id": letter_job })),
    )
        .into_response())
}

/// File names people will see in their downloads folder: ASCII letters,
/// digits, spaces and a few separators only.
pub fn download_name(name: &str, company: Option<&str>, what: &str, ext: &str) -> String {
    let safe = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '.' | '_'))
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut parts = vec![safe(name)];
    if let Some(c) = company.map(safe).filter(|c| !c.is_empty()) {
        parts.push(c);
    }
    parts.push(what.to_string());
    let base: String = parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    format!("{}.{ext}", base.chars().take(120).collect::<String>())
}

async fn link(
    state: &AppState,
    key: Option<&str>,
    name: String,
) -> Result<Option<String>, AppError> {
    match key {
        Some(k) => Ok(Some(state.r2.presign_get(k, LINK_TTL, Some(&name)).await?)),
        None => Ok(None),
    }
}

/// GET /v1/applications/{id}/files: download links for the newest rendered
/// CV and letter, and whether the CV render matches the current decisions.
pub async fn files(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    #[derive(sqlx::FromRow)]
    struct Row {
        company: Option<String>,
        latest_cv_version_id: Option<Uuid>,
        latest_cv_pdf_key: Option<String>,
        latest_cv_docx_key: Option<String>,
        latest_cv_rendered_at: Option<DateTime<Utc>>,
    }
    let r = sqlx::query_as::<_, Row>(
        r#"
        select company, latest_cv_version_id, latest_cv_pdf_key, latest_cv_docx_key, latest_cv_rendered_at
        from applications where id = $1 and user_id = $2
        "#,
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let (_, doc) = pipeline::decided_doc(&state.db, user.id, app_id).await?;
    let current_sections = serde_json::to_value(&doc).map_err(anyhow::Error::from)?;
    let rendered_sections: Option<Value> = match r.latest_cv_version_id {
        Some(id) => {
            sqlx::query_scalar("select sections from cv_versions where id = $1 and user_id = $2")
                .bind(id)
                .bind(user.id)
                .fetch_optional(&state.db)
                .await?
        }
        None => None,
    };
    let name = doc.header.name.as_str();
    let company = r.company.as_deref();
    let letter: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select r2_pdf_key, r2_docx_key from cover_letters where application_id = $1 and user_id = $2 order by generated_at desc limit 1",
    )
    .bind(app_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;
    let (lpdf, ldocx) = letter.unwrap_or((None, None));
    Ok(Json(json!({
        "cv": {
            "pdf_url": link(&state, r.latest_cv_pdf_key.as_deref(), download_name(name, company, "CV", "pdf")).await?,
            "docx_url": link(&state, r.latest_cv_docx_key.as_deref(), download_name(name, company, "CV", "docx")).await?,
            "rendered_at": r.latest_cv_rendered_at,
            "up_to_date": rendered_sections.as_ref() == Some(&current_sections),
        },
        "letter": {
            "pdf_url": link(&state, lpdf.as_deref(), download_name(name, company, "Cover letter", "pdf")).await?,
            "docx_url": link(&state, ldocx.as_deref(), download_name(name, company, "Cover letter", "docx")).await?,
        },
        "expires_in_seconds": LINK_TTL.as_secs(),
    })))
}

#[derive(sqlx::FromRow)]
struct CvDocRow {
    id: Uuid,
    company: Option<String>,
    role: Option<String>,
    at: DateTime<Utc>,
    docx: Option<String>,
    score: Option<i32>,
}

#[derive(sqlx::FromRow)]
struct LetterDocRow {
    id: Uuid,
    app_id: Uuid,
    company: Option<String>,
    tone: String,
    body: String,
    at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct DocumentsQuery {
    pub kind: Option<String>,
}

/// GET /v1/documents?kind=cv|letter: rendered CVs and written letters, newest
/// first, for the Documents screen.
pub async fn documents(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<DocumentsQuery>,
) -> Result<Json<Value>, AppError> {
    let kind = q.kind.as_deref().unwrap_or("all");
    crate::validate::one_of("kind", kind, &["all", "cv", "letter"])?;
    let mut docs: Vec<(DateTime<Utc>, Value)> = Vec::new();
    if kind != "letter" {
        let rows: Vec<CvDocRow> = sqlx::query_as(
            r#"
            select a.id, a.company, a.role, a.latest_cv_rendered_at as at, a.latest_cv_docx_key as docx,
                   (select score from ats_scores s where s.application_id = a.id and s.user_id = a.user_id
                    and s.kind in ('rescore', 'projected') order by s.kind = 'rescore' desc, s.created_at desc limit 1) as score
            from applications a
            where a.user_id = $1 and a.latest_cv_pdf_key is not null and a.latest_cv_rendered_at is not null
            "#,
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
        for CvDocRow {
            id,
            company,
            role,
            at,
            docx,
            score,
        } in rows
        {
            docs.push((at, json!({
                "kind": "cv", "application_id": id, "company": company, "role": role, "score": score,
                "formats": if docx.is_some() { json!(["pdf", "docx"]) } else { json!(["pdf"]) },
                "updated_at": at,
            })));
        }
    }
    if kind != "cv" {
        let rows: Vec<LetterDocRow> = sqlx::query_as(
            r#"
            select distinct on (l.application_id) l.id, l.application_id as app_id, a.company, l.tone, l.body, l.generated_at as at
            from cover_letters l join applications a on a.id = l.application_id and a.user_id = l.user_id
            where l.user_id = $1
            order by l.application_id, l.generated_at desc
            "#,
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
        for LetterDocRow {
            id,
            app_id,
            company,
            tone,
            body,
            at,
        } in rows
        {
            docs.push((at, json!({
                "kind": "letter", "id": id, "application_id": app_id, "company": company, "tone": tone,
                "words": body.split_whitespace().count(), "updated_at": at,
            })));
        }
    }
    docs.sort_by_key(|d| std::cmp::Reverse(d.0));
    Ok(Json(
        json!({ "documents": docs.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }),
    ))
}

#[cfg(test)]
mod tests {
    use super::download_name;

    #[test]
    fn download_names_are_plain_ascii() {
        assert_eq!(
            download_name("Ada Okafor", Some("Halcyon Health"), "CV", "pdf"),
            "Ada Okafor Halcyon Health CV.pdf"
        );
        assert_eq!(
            download_name("Ada \"x\"\r\n", Some("A/B; rm"), "CV", "pdf"),
            "Ada x AB rm CV.pdf"
        );
        assert_eq!(
            download_name("Zoë", None, "Cover letter", "docx"),
            "Zo Cover letter.docx"
        );
    }
}
