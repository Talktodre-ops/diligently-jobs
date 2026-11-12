//! The master CV: versioned edits, validation, and the Check screen's issues.

mod common;

use axum::http::StatusCode;
use common::{Client, TestApp};
use serde_json::{json, Value};

async fn user<'a>(app: &'a TestApp, email: &str) -> Client<'a> {
    let c = app.client();
    c.post(
        "/v1/auth/signup",
        json!({ "email": email, "password": "a long enough passphrase" }),
    )
    .await;
    c
}

fn doc() -> Value {
    json!({
        "header": { "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com",
                    "linkedin": { "url": "https://linkedin.com/in/ada", "display": "linkedin.com/in/ada" } },
        "summary": "Backend engineer who builds payment systems.",
        "experience": [
            { "role": "Senior Backend Engineer", "company": "Northfold", "start": "2021", "end": "Present",
              "bullets": ["Cut ledger reconciliation time by 60%"] },
            { "role": "Software Engineer", "company": "Kestrel", "bullets": ["Built the billing API"] }
        ],
        "education": [{ "institution": "University of Lagos", "degree": "B.Sc. Computer Science" }],
        "skills": [{ "label": "Languages", "items": ["Go", "Rust", "SQL"] }],
        "projects": []
    })
}

#[tokio::test]
async fn no_master_until_one_is_saved() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let res = c.get("/v1/cv/master").await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.body["error"]["code"], "no_master_cv");
}

#[tokio::test]
async fn saving_returns_the_doc_and_flags_missing_dates() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let res = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": doc() })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.body);
    assert_eq!(res.body["cv"]["doc"]["header"]["name"], "Ada Okafor");
    let issues = res.body["cv"]["issues"].as_array().unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0]["path"], "experience[1]");
    assert!(issues[0]["message"].as_str().unwrap().contains("Kestrel"));
    assert_eq!(
        c.get("/v1/cv/master").await.body["cv"]["id"],
        res.body["cv"]["id"]
    );
}

#[tokio::test]
async fn editing_creates_a_new_version_and_keeps_the_old_one() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let first = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": doc() })),
        )
        .await;
    let first_id = first.body["cv"]["id"].as_str().unwrap().to_string();

    let mut fixed = doc();
    fixed["experience"][1]["start"] = json!("2016");
    fixed["experience"][1]["end"] = json!("2018");
    let second = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": fixed })),
        )
        .await;
    let second_id = second.body["cv"]["id"].as_str().unwrap().to_string();
    assert_ne!(first_id, second_id);
    assert_eq!(second.body["cv"]["issues"], json!([]));

    // The old version is still there, unchanged, and the new one records its origin.
    let old = c.get(&format!("/v1/cv-versions/{first_id}")).await;
    assert_eq!(old.status, StatusCode::OK);
    assert_eq!(old.body["sections"]["experience"][1]["start"], "");
    let based_on: Option<uuid::Uuid> =
        sqlx::query_scalar("select based_on_id from cv_versions where id = $1::uuid")
            .bind(&second_id)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(based_on.unwrap().to_string(), first_id);
}

#[tokio::test]
async fn invalid_docs_are_refused_with_the_path() {
    let app = TestApp::spawn().await;
    let c = user(&app, "ada@example.com").await;
    let mut bad = doc();
    bad["experience"][0]["bullets"] = json!(["x".repeat(601)]);
    let res = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": bad })),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res.body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("experience[0].bullets[0]"));

    let mut bad = doc();
    bad["header"]["linkedin"]["url"] = json!("javascript:alert(1)");
    let res = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": bad })),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);

    let res = c
        .send(
            axum::http::Method::PUT,
            "/v1/cv/master",
            Some(json!({ "doc": { "header": {} } })),
        )
        .await;
    assert_eq!(
        res.status,
        StatusCode::BAD_REQUEST,
        "missing name is a shape error"
    );
}

#[tokio::test]
async fn master_cv_is_per_user() {
    let app = TestApp::spawn().await;
    let a = user(&app, "a@example.com").await;
    let b = user(&app, "b@example.com").await;
    a.send(
        axum::http::Method::PUT,
        "/v1/cv/master",
        Some(json!({ "doc": doc() })),
    )
    .await;
    assert_eq!(
        b.get("/v1/cv/master").await.body["error"]["code"],
        "no_master_cv"
    );
}
