//! Render the tailored CV and letter, download them through presigned
//! links, and list them on the Documents screen.

mod common;
#[path = "support/pipeline_fixture.rs"]
mod fixture;

use axum::http::StatusCode;
use common::TestApp;
use fixture::{ready_user, started};
use serde_json::json;

#[tokio::test]
async fn render_then_download_real_files() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = started(&app, &c).await;

    let r = c
        .post(
            &format!("/v1/applications/{id}/render"),
            json!({ "include_letter": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.body);
    assert!(r.body["letter_job_id"].is_string());
    assert_eq!(app.drain_jobs().await, 2);

    let f = c.get(&format!("/v1/applications/{id}/files")).await.body;
    assert_eq!(f["cv"]["up_to_date"], true, "{f}");
    let http = reqwest::Client::new();
    for (url, ext, magic) in [
        (&f["cv"]["pdf_url"], "pdf", &b"%PDF-"[..]),
        (&f["cv"]["docx_url"], "docx", &b"PK"[..]),
        (&f["letter"]["pdf_url"], "pdf", &b"%PDF-"[..]),
    ] {
        let resp = http
            .get(url.as_str().expect("link present"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "presigned link works");
        let cd = resp.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            cd.contains("Ada Okafor Halcyon Health") && cd.ends_with(&format!(".{ext}\"")),
            "{cd}"
        );
        assert!(resp.bytes().await.unwrap().starts_with(magic));
    }

    // A new decision makes the rendered CV stale until rendered again.
    let rw = c.get(&format!("/v1/applications/{id}/rewrites")).await.body;
    let rid = rw["rewrites"][0]["id"].as_str().unwrap().to_string();
    c.patch(
        &format!("/v1/rewrites/{rid}"),
        json!({ "action": "accept" }),
    )
    .await;
    let f = c.get(&format!("/v1/applications/{id}/files")).await.body;
    assert_eq!(f["cv"]["up_to_date"], false);

    let docs = c.get("/v1/documents").await.body;
    let kinds: Vec<&str> = docs["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"cv") && kinds.contains(&"letter"), "{docs}");
    let cvs = c.get("/v1/documents?kind=cv").await.body;
    assert!(cvs["documents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|d| d["kind"] == "cv"));
    assert_eq!(cvs["documents"][0]["company"], "Halcyon Health");
    assert_eq!(
        c.get("/v1/documents?kind=pictures").await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn files_before_any_render_are_absent_and_render_needs_a_letter_if_asked() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    fixture::answer_everything(&app);
    let res = c
        .post(
            "/v1/applications/start",
            json!({ "jd_text": fixture::JD, "letter": false }),
        )
        .await;
    let id = res.body["application_id"].as_str().unwrap().to_string();
    app.drain_jobs().await;
    let f = c.get(&format!("/v1/applications/{id}/files")).await.body;
    assert_eq!(f["cv"]["pdf_url"], serde_json::Value::Null);
    assert_eq!(f["cv"]["up_to_date"], false);
    let r = c
        .post(
            &format!("/v1/applications/{id}/render"),
            json!({ "include_letter": true }),
        )
        .await;
    assert_eq!(r.body["error"]["code"], "no_letter");
}

#[tokio::test]
async fn another_user_cannot_render_or_download() {
    let app = TestApp::spawn().await;
    let a = ready_user(&app, "a@example.com").await;
    let b = ready_user(&app, "b@example.com").await;
    let id = started(&app, &a).await;
    assert_eq!(
        b.post(&format!("/v1/applications/{id}/render"), json!({}))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.get(&format!("/v1/applications/{id}/files")).await.status,
        StatusCode::NOT_FOUND
    );
    a.post(&format!("/v1/applications/{id}/render"), json!({}))
        .await;
    app.drain_jobs().await;
    assert_eq!(b.get("/v1/documents").await.body["documents"], json!([]));
}
