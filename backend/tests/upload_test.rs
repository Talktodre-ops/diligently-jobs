//! CV upload: validation, storage, the parse job, and onboarding progress.

mod common;

use axum::http::StatusCode;
use common::{verified_user, TestApp};
use diligently_api::ai::LlmError;
use diligently_api::render::{docx, resume::ResumeDoc, Paper};
use serde_json::{json, Value};

const PDF: &[u8] = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n";

fn parsed_cv() -> Value {
    json!({
        "header": { "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com",
                    "phone": null, "linkedin": { "url": "https://linkedin.com/in/ada", "display": "linkedin.com/in/ada" },
                    "github": null, "website": null },
        "summary": "Backend engineer.",
        "experience": [
            { "role": "Senior Backend Engineer", "company": "Northfold", "location": "Lagos", "start": "2021", "end": "Present",
              "bullets": ["Cut reconciliation time by 60%"] },
            { "role": "Software Engineer", "company": "Kestrel", "location": null, "start": "", "end": "",
              "bullets": ["Built the billing API"] }
        ],
        "education": [{ "institution": "University of Lagos", "location": null, "degree": "B.Sc.", "start": null, "end": null }],
        "skills": [{ "label": "Languages", "items": ["Go", "Rust"] }],
        "projects": []
    })
}

#[tokio::test]
async fn unverified_users_cannot_upload() {
    let app = TestApp::spawn().await;
    let c = app.client();
    c.post(
        "/v1/auth/signup",
        json!({ "email": "ada@example.com", "password": "a long enough passphrase" }),
    )
    .await;
    let res = c
        .upload("/v1/cv/upload", "cv.pdf", "application/pdf", PDF)
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.body["error"]["code"], "email_not_verified");
}

#[tokio::test]
async fn bad_files_are_refused_before_any_work() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    for (name, ct, bytes) in [
        (
            "cv.pdf",
            "application/pdf",
            b"MZ\x90\x00 an executable".to_vec(),
        ),
        ("cv.exe", "application/octet-stream", PDF.to_vec()),
        ("cv.docx", "application/pdf", PDF.to_vec()),
        (
            "cv.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            b"PK\x03\x04junk".to_vec(),
        ),
        ("cv.pdf", "application/pdf", Vec::new()),
        (
            "cv.pdf",
            "application/pdf",
            [PDF, &vec![b' '; 5 * 1024 * 1024]].concat(),
        ),
    ] {
        let res = c.upload("/v1/cv/upload", name, ct, &bytes).await;
        assert_eq!(
            res.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{name} {ct}: {}",
            res.body
        );
        assert_eq!(res.body["error"]["field"], "file");
    }
    assert_eq!(app.ai.requests().len(), 0);
    let n: i64 = sqlx::query_scalar("select count(*) from cv_uploads")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn pdf_upload_becomes_the_master_cv_and_moves_onboarding_on() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    app.ai.answer("cv_parse", parsed_cv());

    let res = c
        .upload("/v1/cv/upload", "Ada CV.pdf", "application/pdf", PDF)
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
    let id = res.body["upload"]["id"].as_str().unwrap().to_string();
    assert_eq!(res.body["upload"]["status"], "queued");

    assert_eq!(app.drain_jobs().await, 1);
    let up = c.get(&format!("/v1/cv/uploads/{id}")).await;
    assert_eq!(up.body["upload"]["status"], "done", "{}", up.body);

    let master = c.get("/v1/cv/master").await;
    assert_eq!(master.body["cv"]["doc"]["header"]["name"], "Ada Okafor");
    assert_eq!(master.body["cv"]["issues"][0]["path"], "experience[1]");

    let profile = c.get("/v1/profile").await.body;
    assert_eq!(profile["profile"]["onboarding_step"], "check");
    assert_eq!(profile["profile"]["full_name"], "Ada Okafor");

    let req = &app.ai.requests()[0];
    assert_eq!(req.task, "cv_parse");
    assert!(
        req.pdf_base64.as_deref().unwrap().starts_with("JVBERi0"),
        "PDF sent as a document"
    );

    let key: String = sqlx::query_scalar("select storage_key from cv_uploads")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let uid = c.get("/v1/auth/me").await.body["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(key.starts_with(&format!("u/{uid}/uploads/")));
    assert_eq!(app.state.r2.get(&key).await.unwrap(), PDF);
    let billed: i64 = sqlx::query_scalar("select count(*) from ai_usage where task = 'cv_parse'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(billed, 1);
}

#[tokio::test]
async fn docx_upload_sends_extracted_text() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    app.ai.answer("cv_parse", parsed_cv());
    let doc: ResumeDoc = serde_json::from_value(json!({
        "header": { "name": "Ada Okafor", "title": "Backend Engineer" },
        "experience": [{ "role": "Engineer", "company": "Northfold", "start": "2021", "end": "Now",
                         "bullets": ["Cut reconciliation time by 60% across three ledgers"] }]
    }))
    .unwrap();
    let bytes = docx::render_resume_doc(&doc, Paper::A4).unwrap();
    let res = c
        .upload(
            "/v1/cv/upload",
            "cv.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            &bytes,
        )
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED, "{}", res.body);
    app.drain_jobs().await;
    let req = &app.ai.requests()[0];
    assert!(req.pdf_base64.is_none());
    assert!(
        req.user_text.contains("Cut reconciliation time by 60%"),
        "{}",
        req.user_text
    );
}

#[tokio::test]
async fn a_failed_parse_is_reported_on_the_upload_and_not_retried() {
    let app = TestApp::spawn().await;
    let c = verified_user(&app, "ada@example.com").await;
    app.ai.fail("cv_parse", LlmError::Upstream("boom".into()));
    let res = c
        .upload("/v1/cv/upload", "cv.pdf", "application/pdf", PDF)
        .await;
    let id = res.body["upload"]["id"].as_str().unwrap().to_string();
    app.drain_jobs().await;
    let up = c.get(&format!("/v1/cv/uploads/{id}")).await;
    assert_eq!(up.body["upload"]["status"], "failed");
    assert!(
        up.body["upload"]["error"]
            .as_str()
            .unwrap()
            .contains("Try again"),
        "{}",
        up.body
    );
    assert_eq!(app.ai.calls("cv_parse"), 1, "no second paid attempt");
    assert_eq!(
        c.get("/v1/cv/master").await.body["error"]["code"],
        "no_master_cv"
    );
}

#[tokio::test]
async fn another_user_cannot_see_an_upload() {
    let app = TestApp::spawn().await;
    let a = verified_user(&app, "a@example.com").await;
    let b = verified_user(&app, "b@example.com").await;
    app.ai.answer("cv_parse", parsed_cv());
    let res = a
        .upload("/v1/cv/upload", "cv.pdf", "application/pdf", PDF)
        .await;
    let id = res.body["upload"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        b.get(&format!("/v1/cv/uploads/{id}")).await.status,
        StatusCode::NOT_FOUND
    );
    app.drain_jobs().await;
    assert_eq!(
        b.get("/v1/cv/master").await.body["error"]["code"],
        "no_master_cv"
    );
}
