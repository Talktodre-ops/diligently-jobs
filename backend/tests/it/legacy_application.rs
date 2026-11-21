//! Applications carried over from the desktop app have no base CV. They
//! answer with a clear conflict instead of a server error, and can be
//! tailored again into a new application from their saved posting.

use crate::common;
use crate::fixture;

use axum::http::StatusCode;
use common::TestApp;
use fixture::{answer_everything, ready_user, JD};
use serde_json::json;
use uuid::Uuid;

async fn legacy_app(app: &TestApp, email: &str, jd: &str, url: Option<&str>) -> Uuid {
    sqlx::query_scalar(
        r#"
        insert into applications (user_id, jd_raw, source_url, status, company, role)
        select id, $2, $3, 'applied', 'Euphoric', 'Software Engineer' from users where email = $1
        returning id
        "#,
    )
    .bind(email)
    .bind(jd)
    .bind(url)
    .fetch_one(&app.state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_desktop_application_says_so_instead_of_failing() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = legacy_app(&app, "ada@example.com", JD, None).await;

    let b = c.get(&format!("/v1/applications/{id}/brief")).await;
    assert_eq!(b.status, StatusCode::OK, "{}", b.body);
    assert_eq!(b.body["application"]["legacy"], true);
    assert!(b.body["application"]["retailored_to"].is_null());

    for path in ["cv", "files", "rewrites"] {
        let r = c.get(&format!("/v1/applications/{id}/{path}")).await;
        assert_eq!(r.status, StatusCode::CONFLICT, "{path}: {}", r.body);
        assert_eq!(r.body["error"]["code"], "legacy_application", "{path}");
    }
    let r = c
        .post(
            &format!("/v1/applications/{id}/render"),
            json!({ "include_letter": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
}

#[tokio::test]
async fn tailoring_again_starts_one_new_application_from_the_saved_posting() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let old = legacy_app(&app, "ada@example.com", JD, None).await;
    answer_everything(&app);

    let r = c
        .post(&format!("/v1/applications/{old}/tailor-again"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.body);
    let new = r.body["application_id"].as_str().unwrap().to_string();
    assert_ne!(new, old.to_string());
    app.drain_jobs().await;

    let b = c.get(&format!("/v1/applications/{new}/brief")).await.body;
    assert_eq!(b["application"]["legacy"], false, "{b}");
    let rw = c.get(&format!("/v1/applications/{new}/rewrites")).await;
    assert_eq!(rw.status, StatusCode::OK, "{}", rw.body);
    let jd: String = sqlx::query_scalar("select jd_raw from applications where id = $1::uuid")
        .bind(&new)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(jd, JD);

    // The old one keeps its history and points at the new one.
    let b = c.get(&format!("/v1/applications/{old}/brief")).await.body;
    assert_eq!(b["application"]["retailored_to"], new.as_str(), "{b}");
    assert_eq!(b["application"]["status"], "applied");

    // Asking again opens the same new application.
    let r = c
        .post(&format!("/v1/applications/{old}/tailor-again"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["application_id"], new.as_str());
    let count: i64 = sqlx::query_scalar("select count(*) from applications")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(count, 2);

    // An application made here is not tailored "again".
    let r = c
        .post(&format!("/v1/applications/{new}/tailor-again"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    assert_eq!(r.body["error"]["code"], "already_tailored");
}

#[tokio::test]
async fn without_a_saved_posting_it_asks_for_a_new_job() {
    let app = TestApp::spawn().await;
    let c = ready_user(&app, "ada@example.com").await;
    let id = legacy_app(&app, "ada@example.com", "Engineer, London", None).await;
    let r = c
        .post(&format!("/v1/applications/{id}/tailor-again"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!(r.body["error"]["code"], "no_saved_posting");
}

#[tokio::test]
async fn someone_else_cannot_tailor_your_old_application() {
    let app = TestApp::spawn().await;
    ready_user(&app, "ada@example.com").await;
    let id = legacy_app(&app, "ada@example.com", JD, None).await;
    let other = ready_user(&app, "eve@example.com").await;
    let r = other
        .post(&format!("/v1/applications/{id}/tailor-again"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
}
