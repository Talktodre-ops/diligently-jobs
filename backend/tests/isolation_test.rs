//! Standing regression gate: one user can never read, list, change, render,
//! presign or attach to another user's data. Every resource route appears
//! here. When a new user-owned route is added, add it here too.

mod common;

use axum::http::StatusCode;
use common::{Client, TestApp};
use serde_json::{json, Value};

async fn user<'a>(app: &'a TestApp, email: &str) -> Client<'a> {
    common::verified_user(app, email).await
}

struct Seed {
    app_id: String,
    cv_id: String,
    letter_id: String,
    interview_id: String,
    job_id: String,
}

/// Everything user A owns, created through A's own API calls.
async fn seed(a: &Client<'_>) -> Seed {
    let res = a
        .post("/v1/applications", json!({ "jd_raw": "Senior Backend Engineer at Halcyon", "company": "Halcyon", "role": "Senior Backend Engineer" }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let app_id = res.body["id"].as_str().unwrap().to_string();

    let res = a
        .post("/v1/cv-versions", json!({ "application_id": app_id, "sections": [{"title": "Experience", "items": ["Built things"]}], "label": "tailored" }))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let cv_id = res.body["id"].as_str().unwrap().to_string();

    // Letters and research are written by the pipeline; seed them directly.
    let letter_id: uuid::Uuid = sqlx::query_scalar(
        "insert into cover_letters (application_id, user_id, body, doc) select id, user_id, 'Dear Halcyon', '{\"candidate_name\": \"Ada\", \"paragraphs\": [\"Hi\"]}' from applications where id = $1::uuid returning id",
    )
    .bind(&app_id)
    .fetch_one(&a.app.state.db)
    .await
    .unwrap();
    let letter_id = letter_id.to_string();
    sqlx::query(
        "insert into company_research (application_id, user_id, brief) select id, user_id, '{\"overview\": \"Health data\"}' from applications where id = $1::uuid",
    )
    .bind(&app_id)
    .execute(&a.app.state.db)
    .await
    .unwrap();

    let res = a
        .post(
            "/v1/interviews",
            json!({ "application_id": app_id, "notes": "first round" }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    let interview_id = res.body["id"].as_str().unwrap().to_string();

    let res = a
        .post(
            "/v1/events",
            json!({ "kind": "note", "application_id": app_id, "payload": {"secret": "A only"} }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);

    // No LLM in tests, so the score row is written directly, as the job would.
    sqlx::query(
        "insert into ats_scores (application_id, user_id, score) select id, user_id, 80 from applications where id = $1::uuid",
    )
    .bind(&app_id)
    .execute(&a.app.state.db)
    .await
    .unwrap();

    let res = a
        .post(&format!("/v1/cv-versions/{cv_id}/render"), json!({}))
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
    let job_id = res.body["job_id"].as_str().unwrap().to_string();

    Seed {
        app_id,
        cv_id,
        letter_id,
        interview_id,
        job_id,
    }
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("expected a list, got {v}"))
        .iter()
        .map(|x| x["id"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn user_b_sees_none_of_user_a_in_lists() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let b = user(&app, "b@example.com").await;
    let s = seed(&a).await;

    // A sees their own data (proves the lists are not just empty).
    assert!(ids(&a.get("/v1/applications").await.body).contains(&s.app_id));
    assert!(ids(&a.get("/v1/cv-versions").await.body).contains(&s.cv_id));
    assert!(!ids(&a.get("/v1/events").await.body).is_empty());
    assert!(ids(&a.get("/v1/interviews").await.body).contains(&s.interview_id));

    for path in [
        "/v1/applications".to_string(),
        "/v1/cv-versions".to_string(),
        "/v1/cv-versions?base_only=true".to_string(),
        format!("/v1/cv-versions?application_id={}", s.app_id),
        "/v1/events".to_string(),
        format!("/v1/events?application_id={}", s.app_id),
        "/v1/interviews".to_string(),
        format!("/v1/interviews?application_id={}", s.app_id),
    ] {
        let res = b.get(&path).await;
        assert_eq!(res.status, StatusCode::OK, "{path}");
        assert_eq!(
            ids(&res.body),
            Vec::<String>::new(),
            "B listed A's rows at {path}"
        );
    }
}

#[tokio::test]
async fn user_b_cannot_read_user_a_by_id() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let b = user(&app, "b@example.com").await;
    let s = seed(&a).await;

    for path in [
        format!("/v1/applications/{}", s.app_id),
        format!("/v1/applications/{}/research", s.app_id),
        format!("/v1/applications/{}/cover-letters", s.app_id),
        format!("/v1/applications/{}/ats-score", s.app_id),
        format!("/v1/cv-versions/{}", s.cv_id),
        format!("/v1/interviews/{}", s.interview_id),
        format!("/v1/jobs/{}", s.job_id),
    ] {
        let res = b.get(&path).await;
        assert_eq!(
            res.status,
            StatusCode::NOT_FOUND,
            "B read {path}: {}",
            res.body
        );
        // And A can, so the 404 is about ownership, not a broken route.
        assert_ne!(
            a.get(&path).await.status,
            StatusCode::NOT_FOUND,
            "A should read {path}"
        );
    }

    let res = b
        .get(&format!("/v1/applications/{}/timeline", s.app_id))
        .await;
    assert!(
        res.status == StatusCode::NOT_FOUND || ids(&res.body).is_empty(),
        "B read A's timeline: {}",
        res.body
    );
}

#[tokio::test]
async fn user_b_cannot_change_or_attach_to_user_a() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let b = user(&app, "b@example.com").await;
    let s = seed(&a).await;

    let attempts: Vec<(&str, String, Value)> = vec![
        (
            "PATCH",
            format!("/v1/applications/{}", s.app_id),
            json!({ "status": "applied" }),
        ),
        (
            "PATCH",
            format!("/v1/interviews/{}", s.interview_id),
            json!({ "notes": "B was here" }),
        ),
        (
            "POST",
            format!("/v1/applications/{}/research/refresh", s.app_id),
            json!({}),
        ),
        (
            "POST",
            format!("/v1/applications/{}/cover-letters/regenerate", s.app_id),
            json!({ "tone": "warm" }),
        ),
        (
            "PATCH",
            format!("/v1/cover-letters/{}", s.letter_id),
            json!({ "paragraphs": ["B was here"] }),
        ),
        (
            "POST",
            format!("/v1/applications/{}/ats-score", s.app_id),
            json!({}),
        ),
        (
            "POST",
            format!("/v1/cv-versions/{}/render", s.cv_id),
            json!({}),
        ),
        (
            "POST",
            format!("/v1/cover-letters/{}/render", s.letter_id),
            json!({}),
        ),
        (
            "POST",
            "/v1/cv-versions".to_string(),
            json!({ "application_id": s.app_id, "sections": [] }),
        ),
        (
            "POST",
            "/v1/interviews".to_string(),
            json!({ "application_id": s.app_id }),
        ),
        (
            "POST",
            "/v1/events".to_string(),
            json!({ "kind": "x", "application_id": s.app_id }),
        ),
    ];
    for (method, path, body) in attempts {
        let res = match method {
            "PATCH" => b.patch(&path, body).await,
            _ => b.post(&path, body).await,
        };
        assert_eq!(
            res.status,
            StatusCode::NOT_FOUND,
            "B {method} {path}: {}",
            res.body
        );
    }

    // Nothing of A's changed.
    let a_app = a.get(&format!("/v1/applications/{}", s.app_id)).await;
    assert_ne!(a_app.body["status"], "applied");
    let a_iv = a.get(&format!("/v1/interviews/{}", s.interview_id)).await;
    assert_eq!(a_iv.body["notes"], "first round");
}

#[tokio::test]
async fn user_b_cannot_presign_user_a_files() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let b = user(&app, "b@example.com").await;
    let s = seed(&a).await;

    let a_me = a.get("/v1/auth/me").await;
    let a_id = a_me.body["user"]["id"].as_str().unwrap();
    let key = format!("u/{a_id}/cvs/{}.pdf", s.cv_id);

    let res = b
        .post("/v1/blobs/presign-download", json!({ "key": key }))
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND, "{}", res.body);

    let res = a
        .post("/v1/blobs/presign-download", json!({ "key": key }))
        .await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "A presigns own file: {}",
        res.body
    );
}

#[tokio::test]
async fn signed_out_requests_get_nothing() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let s = seed(&a).await;
    let anon = app.client();
    for path in [
        "/v1/applications".to_string(),
        format!("/v1/applications/{}", s.app_id),
        "/v1/events".to_string(),
        format!("/v1/jobs/{}", s.job_id),
    ] {
        assert_eq!(
            anon.get(&path).await.status,
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
    }
}
