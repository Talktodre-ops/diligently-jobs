//! Shared setup for pipeline tests: a verified user with a master CV and
//! canned AI answers for every pipeline step.
#![allow(dead_code)]

use axum::http::Method;
use serde_json::{json, Value};

use crate::common::{verified_user, Client, TestApp};

pub const JD: &str = "Senior Backend Engineer at Halcyon Health. Halcyon builds claims-processing software for clinics. You will own the services that ingest and reconcile insurance claims. Requirements: 5+ years with Go or Rust, PostgreSQL at scale, Kafka, GraphQL API design, experience with HIPAA data. Nice to have: Kubernetes, Terraform.";

pub fn master_cv() -> Value {
    json!({
        "header": { "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com" },
        "summary": "Backend engineer with 7 years in payments.",
        "experience": [
            { "role": "Senior Backend Engineer", "company": "Northfold", "start": "2021", "end": "Present",
              "bullets": ["Cut ledger reconciliation time by 60% with Kafka consumers in Go", "Designed Postgres partitioning for 400M rows"] },
            { "role": "Backend Engineer", "company": "Quarry Labs", "start": "2018", "end": "2021",
              "bullets": ["Built the billing API in Rust"] }
        ],
        "skills": [{ "label": "Languages", "items": ["Go", "Rust"] }]
    })
}

pub fn answer_everything(app: &TestApp) {
    app.ai.answer("jd_analysis", json!({
        "role": "Senior Backend Engineer", "company": "Halcyon Health", "location": null, "seniority": "Senior",
        "summary": "Own claims ingestion services.", "required": ["Go or Rust", "PostgreSQL", "Kafka", "GraphQL", "HIPAA"],
        "nice_to_have": ["Kubernetes"], "keywords": ["Go", "PostgreSQL", "Kafka", "GraphQL", "HIPAA", "claims"]
    }));
    app.ai.answer("ats_score", json!({ "score": 72, "matched_keywords": ["Go", "Kafka"], "missing_keywords": ["GraphQL"], "notes": "No GraphQL." }));
    app.ai.answer("gap_analysis", json!({ "gaps": [
        { "requirement": "Go or Rust", "importance": "required", "status": "covered", "evidence": "E1.B1", "ask": null },
        { "requirement": "GraphQL API design", "importance": "required", "status": "missing", "evidence": null, "ask": "Have you designed GraphQL APIs?" },
        { "requirement": "HIPAA data", "importance": "required", "status": "missing", "evidence": null, "ask": "Have you handled HIPAA data?" }
    ] }));
    app.ai.answer("rewrites", json!({
        "summary": "Backend engineer with 7 years building reconciliation systems in Go and Rust.",
        "rewrites": [
            { "bullet_id": "E1.B1", "rewrite": "Cut claims-style reconciliation time 60% with Go Kafka consumers", "why": "Matches claims reconciliation.", "needs_number": false },
            { "bullet_id": "E1.B2", "rewrite": "Designed PostgreSQL partitioning for 400M rows to keep queries fast", "why": "Uses the PostgreSQL at scale wording.", "needs_number": true }
        ]
    }));
    app.web.hits(vec![diligently_api::web::SearchHit {
        title: "Halcyon Health raises Series B".into(),
        url: "https://news.example/halcyon".into(),
        snippet: "Halcyon Health, a claims software company for clinics, raised a Series B.".into(),
        published: Some("2026-10-01".into()),
    }]);
    app.ai.answer("research_brief", json!({
        "overview": "Halcyon Health builds claims software for clinics.", "products": ["Claims platform"],
        "recent_news": [{ "text": "Raised a Series B", "source": 1 }], "culture": [],
        "talking_points": [{ "text": "Series B growth means scaling claims ingestion", "source": 1 }],
        "why_them": "Clinics get paid faster when claims reconcile cleanly."
    }));
    app.ai.answer("cover_letter", json!({ "paragraphs": [
        "Halcyon Health is helping clinics get paid faster, and its recent Series B suggests claims volume is about to grow.",
        "At Northfold I cut ledger reconciliation time by 60% with Kafka consumers in Go, which is the same shape of problem as reconciling claims.",
        "I would like to talk about how that work could help your claims services."
    ] }));
}

pub async fn ready_user<'a>(app: &'a TestApp, email: &str) -> Client<'a> {
    let c = verified_user(app, email).await;
    let res = c
        .send(
            Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": master_cv() })),
        )
        .await;
    assert_eq!(res.status, axum::http::StatusCode::OK, "{}", res.body);
    c
}

/// Start a job from pasted text and run the pipeline to the end.
pub async fn started<'a>(app: &'a TestApp, c: &Client<'a>) -> String {
    answer_everything(app);
    let res = c
        .post("/v1/applications/start", json!({ "jd_text": JD }))
        .await;
    assert_eq!(res.status, axum::http::StatusCode::ACCEPTED, "{}", res.body);
    app.drain_jobs().await;
    res.body["application_id"].as_str().unwrap().to_string()
}
