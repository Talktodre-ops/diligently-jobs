//! The render job end to end: API enqueue, worker, Tectonic, object storage,
//! with the paper size taken from the owner's profile.

mod common;

use axum::http::{Method, StatusCode};
use common::TestApp;
use serde_json::json;

#[tokio::test]
async fn render_job_stores_pdf_and_docx_in_the_users_paper_size() {
    let app = TestApp::spawn().await;
    let c = app.client();
    c.post(
        "/v1/auth/signup",
        json!({ "email": "ada@example.com", "password": "a long enough passphrase" }),
    )
    .await;
    c.patch("/v1/profile", json!({ "paper_size": "letter" }))
        .await;
    let doc = json!({
        "header": { "name": "Ada Okafor", "title": "Backend Engineer", "email": "ada@example.com" },
        "experience": [{ "role": "Engineer", "company": "Northfold", "start": "2021", "end": "Present",
                         "bullets": ["Built a ledger"] }]
    });
    let saved = c
        .send(Method::PUT, "/v1/cv/master", Some(json!({ "doc": doc })))
        .await;
    let cv_id = saved.body["cv"]["id"].as_str().unwrap().to_string();

    let res = c
        .post(&format!("/v1/cv-versions/{cv_id}/render"), json!({}))
        .await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    let job_id = res.body["job_id"].as_str().unwrap().to_string();
    assert_eq!(app.drain_jobs().await, 1);

    let job = c.get(&format!("/v1/jobs/{job_id}")).await;
    assert_eq!(job.body["status"], "done", "{}", job.body);
    let pdf_key = job.body["result"]["pdf_key"].as_str().unwrap().to_string();
    let me = c.get("/v1/auth/me").await;
    let uid = me.body["user"]["id"].as_str().unwrap();
    assert!(pdf_key.starts_with(&format!("u/{uid}/cvs/")), "{pdf_key}");

    let obj = app
        .state
        .r2
        .client
        .get_object()
        .bucket(&app.state.r2.bucket)
        .key(&pdf_key)
        .send()
        .await
        .expect("pdf stored");
    let bytes = obj.body.collect().await.unwrap().into_bytes();
    let pdf = lopdf::Document::load_mem(&bytes).expect("valid PDF");
    let first = *pdf.get_pages().values().next().unwrap();
    let page = pdf.get_dictionary(first).unwrap();
    let mb = match page.get(b"MediaBox") {
        Ok(o) => o.as_array().unwrap().clone(),
        Err(_) => {
            let parent = page.get(b"Parent").unwrap().as_reference().unwrap();
            pdf.get_dictionary(parent)
                .unwrap()
                .get(b"MediaBox")
                .unwrap()
                .as_array()
                .unwrap()
                .clone()
        }
    };
    let w = mb[2].as_float().unwrap() - mb[0].as_float().unwrap();
    assert!((w - 612.0).abs() < 1.0, "US Letter width, got {w}");

    let cv = c.get(&format!("/v1/cv-versions/{cv_id}")).await;
    assert_eq!(cv.body["r2_pdf_key"], pdf_key);
    assert!(cv.body["r2_docx_key"].as_str().unwrap().ends_with(".docx"));
}
